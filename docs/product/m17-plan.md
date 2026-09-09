# M17 — Internal Pilot + Production Rollout Plan

**Goal:** Take ApplyWizz Signal from a locally/CI-verified product (M0–M16, shipped on `main` @ `948b7c7413e01bf183e5179ecd09e5fe1afc2678`) to a small, safe, real internal ApplyWizz production pilot — Microsoft Teams only, a handful of Account Managers and their reporting Manager/Admin, ApplyWizz-managed customer meetings only.

**This is NOT new feature development.** Every product capability the pilot needs (bot join/record, do-not-record request+approval, transcription, meeting intelligence, customer truth proposals, meeting prep/memory, Ask Signal, stuck-job recovery, operational incidents) is already implemented and tested on `main`. M17 is: stand up a real production environment, wire the recurring job scheduling M16 built endpoints for but never scheduled, build the one genuinely-missing piece (internal post-meeting recap email — `packages/email/` and `packages/observability/` are still empty placeholder directories), and run a controlled pilot with real rollback paths.

**Do not reopen or modify M16 code.** Where this plan touches `operational_incidents`/`operations-recovery.ts`, it is strictly additive (new incident types, new scheduled callers of existing functions) — no changes to the M16 recovery/dedup/CAS logic itself.

## How this plan was grounded

Every claim below about "already exists" / "does not exist yet" was checked against the actual repository, not assumed:
- `packages/email/` and `packages/observability/` are empty directories (`ls -la` → 0 files in each) — the `EmailProvider abstraction` and `Logging, metrics, audit helpers` the root `README.md`'s architecture section describes were never built.
- `apps/web/env/server.ts` already defines `getEmailEnv()` (`EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM_ADDRESS`) but it is imported nowhere in the codebase (`grep -rln getEmailEnv` outside env/server.ts itself → zero hits) — genuinely reserved, unused plumbing.
- `packages/microsoft/src/graph-client.ts` already has `createSubscription`/`renewSubscription`/`deleteSubscription`, and `packages/domain/src/microsoft-connection.ts` already has `renewMicrosoftSubscription` wrapping it — but no route or worker calls `renewMicrosoftSubscription` anywhere. Graph calendar subscriptions expire (typically ≤3 days for calendar resources) — this is a real, silent gap: a production pilot running longer than the subscription lifetime will silently stop receiving webhook notifications unless this plan wires renewal.
- `workers/orchestrator/bot-worker.mjs` is a real, working polling loop for meeting-bot orchestration only (`reconcileOrganizationMeetingBots` / `processPendingBotJobs` / `syncBotStatuses` every `BOT_WORKER_TICK_INTERVAL_MS`, default 30s) — but it is not deployed anywhere (no Dockerfile, no process manager config, no systemd unit, nothing in `.github/workflows/`). It only runs if someone manually runs `node --env-file=... workers/orchestrator/bot-worker.mjs` on a machine and leaves it running.
- There is no equivalent worker loop for calendar-event processing, transcription, meeting intelligence, the three reconciliation routes, or M16's own `/api/internal/operations/recover` — all six are `/api/internal/*` POST routes, secret-gated, callable on demand, never scheduled. `.github/workflows/ci.yml` only runs tests/build on push/PR — it has no deploy step and no cron trigger.
- The bot policy behavior the pilot spec describes (AM requests do-not-join/do-not-record, Manager/Admin approval suppresses the bot, rejected/unapproved defaults to join) is **already fully implemented**: `packages/domain/src/meeting-policy.ts` + `packages/domain/src/recording-exceptions.ts`, with `eligibility_status` transitions (`pending_exception` → `approved`/`pending` on reject) and its own pgTAP/unit coverage from earlier milestones. Nothing to build here for the pilot — only to exercise for real.
- `apps/web/app/admin/policies/page.tsx:41-42` already contains the sentence *"participant recording consent/notice is a separate concern, handled elsewhere"* — but nowhere in the codebase is it actually handled. There is no consent banner, no pre-join notice, no Teams meeting-description injection, nothing. This is a real, currently-unresolved gap that matters a lot once real people are being recorded in a real pilot, not a demo.
- No hosting platform (Vercel/Railway/Fly/ECS/self-hosted) appears anywhere in the repo — `README.md` still describes M0 ("only the app shell exists") and has never been updated. This is a genuinely open decision, not something to silently pick.
- No retention/deletion policy exists anywhere (`grep -rln retention` → nothing outside an unrelated roles migration). Genuinely undecided.

---

## Phase 1 pilot scope (as specified, carried into every checkpoint below)

**Pilot users:** a small number of ApplyWizz Account Managers + their reporting Manager/Admin. Microsoft Teams only (no Zoom/Meet for this phase — matches what `packages/meeting-bots` and `packages/microsoft` already support; no other platform adapter exists).

**Meeting scope:** ApplyWizz-managed customer/account meetings that are CRM/scheduler-connected (i.e., meetings `customer_linkage`/`scheduler-linkage` can actually resolve to a real customer — see `packages/domain/src/customer-linkage.ts`, `scheduler-linkage.ts`). Do **not** expand calendar-wide capture to all company meetings — that is explicitly out of scope (Phase 2).

**Bot policy (already implemented, verify don't build):** eligible ApplyWizz meeting → bot joins by default. AM can request do-not-join/do-not-record via the existing recording-exceptions flow. Manager/Admin approval suppresses the join. A rejected or never-decided request defaults to join (existing `eligibility_status` semantics — confirm this default is what the pilot actually wants before go-live, since "defaults to recording" is a real policy choice with real consent implications, see §10).

**Post-meeting (already implemented):** recording/capture, transcript, Signal intelligence, summary, actions, customer truth proposals, meeting prep/memory, Ask Signal — all shipped, all tested. Nothing new here.

**Email (net-new, this plan builds it):** internal-only post-meeting recap to the assigned AM + authorized internal owner/manager. Never automatic to the customer. A customer-safe recap variant may exist as an **unsent draft only** — no send path to any customer address is built in this plan.

---

## 1. Production environment

**Current state:** one local Supabase project (`project_id = "AW_otter"` in `supabase/config.toml`), no linked remote project (`supabase migration list` returns `LegacyProjectNotLinkedError` — established fact from the M12–M16 work this session). No production Supabase project exists yet.

**What M17A must do:**
- Create a real Supabase project (separate from any personal/dev project) — this is an infrastructure action requiring the account holder, not something Claude can do autonomously; flagged as a human action in the checkpoint below.
- Link this repo to it: `supabase link --project-ref <ref>`.
- Apply the full migration history (`supabase db push` or `supabase migration up --linked`) — every migration under `supabase/migrations/` in order, starting from `20260906020001_...` through `20260912160001_operational_incidents.sql` (the last one on `main` as of this SHA).
- Verify schema drift is zero against the linked project the same way `supabase db diff` has been used all session — this is the FIRST time this repo's `db diff` will ever run against a real linked project instead of local-only; expect this to surface anything that only ever worked "by accident" locally (e.g., a migration that assumed local-only extension availability).
- Verify RLS end-to-end against production Postgres, not just local: re-run `supabase test db --linked` (pgTAP works the same way against a linked project) and confirm the full 452-assertion suite passes there too — proves the RLS/SECURITY DEFINER posture isn't a local-Postgres-version artifact.
- Environment separation: production `.env` values live only in the hosting platform's secret store (§2) and in a `apps/web/.env.production.local`-style file that is **never** committed (already covered by `.env*` being gitignored per `README.md:24`) — no new gitignore work needed, just discipline.
- Production URLs: `APP_BASE_URL` and `WEBHOOK_BASE_URL` (both already-required env vars, `apps/web/env/server.ts:62-68`) must point at the real production domain, not `localhost` — this is what Microsoft Graph will actually call back to, so it must be a stable, real, HTTPS-reachable URL before §4 (Graph) can be tested for real.

**M17A execution note:** the actual M17A checkpoint (see `docs/ops/production-environment.md`, `production-secrets-checklist.md`, `production-microsoft-setup.md`) documented and verified all of the above **without** creating a real project or pushing any migration remotely, per explicit instruction — every "verify against the linked project" item above remains to be performed once a real project exists and is explicitly approved.

**New finding from M17A's research, not previously known:** `scripts/bootstrap-admin.mjs`'s own code comment states production user provisioning sends a real invite email via Supabase Auth's SMTP (`supabase.auth.admin.inviteUserByEmail`) — but **Supabase Auth SMTP is not yet configured anywhere** (`[auth.email.smtp]` is disabled in `supabase/config.toml`, local-dev-only), and **no page in `apps/web/app` handles the invite-link redirect** (no consumption of Supabase's `#access_token=...&type=invite` fragment — `apps/web/app/login/page.tsx` only handles sign-in with an already-set password). Both must be resolved before any real pilot user (M17F) can be provisioned. Flagged as an M17B/M17F blocker, not fixed by M17A itself (M17A is documentation/config-readiness only).

## 2. Secrets / configuration inventory

Every server-only secret this app already reads, verified against `apps/web/env/server.ts` directly (not guessed):

| Getter | Env vars | Currently required? | Production note |
|---|---|---|---|
| `getSupabaseServiceRoleKey` | `SUPABASE_SERVICE_ROLE_KEY` | yes | new value, from the new production Supabase project — never reuse the local/dev one |
| `getMicrosoftEnv` | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`, `MICROSOFT_WEBHOOK_CLIENT_STATE` | yes | needs a real production Entra app registration (§4) — dev/test app registration must not be reused for a real pilot with real employee calendars |
| `getEncryptionKey` | `ENCRYPTION_KEY` | yes | at-rest encryption key for stored Microsoft tokens (see `packages/microsoft`) — generate fresh for prod, never copy from dev |
| `getAppBaseUrl` / `getWebhookBaseUrl` | `APP_BASE_URL`, `WEBHOOK_BASE_URL` | yes | real prod domain (§1) |
| `getVexaEnv` | `VEXA_BASE_URL`, `VEXA_API_KEY` | yes | confirm with Vexa whether the current key is dev/sandbox-tier and whether it can actually join real external Teams meetings, or whether a production-tier key/plan change is needed — this is a real question for whoever owns the Vexa account, not assumable |
| `getOpenAiEnv` | `OPENAI_API_KEY` | yes | unused by any currently-wired code path per the getter's own doc comment context (kept for completeness) |
| `getOpenRouterEnv` | `OPENROUTER_API_KEY` | yes | **the getter's own comment says the current key value was exposed in visible process output and is being treated as compromised.** A fresh key MUST be issued for production regardless of what dev is currently using — do not carry the dev key forward. |
| `getEmailEnv` | `EMAIL_PROVIDER_API_KEY`, `EMAIL_FROM_ADDRESS` | yes (defined, never called yet) | needs a real value once §7 picks a concrete provider |
| `getSchedulerEnv` | `APPLYWIZZ_SCHEDULER_BASE_URL` | yes | per the getter's own comment, the real ApplyWizz scheduler API is currently **unauthenticated at the upstream service** — a known, documented upstream production blocker, not something this plan can fix from Signal's side. Flag to whoever owns that service before pilot go-live; recovering scheduled-call context for real customer meetings depends on it. |
| `getCustomerDetailsEnv` | `APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL`, `APPLYWIZZ_CUSTOMER_DETAILS_API_KEY` (optional) | base URL required | real apply-wizz.me production endpoint + key if one exists |
| `getCrmEnv` | `APPLYWIZZ_CRM_BASE_URL`, `APPLYWIZZ_CRM_API_KEY` | yes | confirm which CRM this maps to for the pilot org, if any — `packages/crm` is a reserved adapter, may be unused for Phase 1 if the pilot doesn't need full CRM sync |
| `getInternalQueueSecret` | `INTERNAL_QUEUE_SECRET` | yes | the shared secret every `/api/internal/*` route checks via `validateState` (timing-safe compare, `packages/microsoft/src/auth.ts:11-20`) — generate a fresh high-entropy value for production; this is what gates every scheduled job in §6 |
| `getClientEnv` (browser-safe) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | the only two values that legitimately reach the browser bundle — confirmed by reading `apps/web/env/client.ts` in full, nothing else is exported from it |

**No secrets in browser:** verified structurally, not just by convention — `env/server.ts:1-5` throws at import time if pulled into browser code, and `env/client.ts` only exports the two `NEXT_PUBLIC_*` values above. M17A should add one CI-adjacent check: grep the production build output (`.next/static`) for any of the server-only var *names* as a defense-in-depth smoke test, since a future accidental `NEXT_PUBLIC_`-prefixed secret would bypass the server.ts guard entirely.

**No secrets in logs:** every `console.error`/`console.log` call path touched by M16 review (`bot-worker.mjs`, the `/api/internal/*` routes) logs error *objects*/counts, not raw request bodies or provider payloads — worth a final grep sweep in M17A for any `console.log(process.env...)` or raw-body logging before go-live, since this was never specifically audited before.

## 3. Deployment

**Web app:** Next.js app in `apps/web`. No hosting platform is chosen anywhere in this repo yet — **this is an open decision, not something to silently pick** (see checkpoint M17A). Whatever platform is chosen must support: Node.js ≥22.13 (root `package.json:8`), the pnpm workspace build (`pnpm run build` at repo root), and per-environment secret injection matching the table in §2.

**Worker/process ownership — UPDATED by M17A's runtime analysis** (see `docs/ops/production-environment.md` §11 for the full code-level evidence; this replaces the earlier draft recommendation below with a code-verified one):

`workers/orchestrator/bot-worker.mjs` is the only existing long-running worker. M17A inspected every `/api/internal/*` route's actual per-invocation work and found it bounded for six of seven job types — **except transcription processing**, which unconditionally shells out to the system `ffmpeg`/`ffprobe` binaries (`packages/domain/src/audio-transcode.ts:77,127`, called from `transcription.ts:216`) — a real OS-level binary dependency standard serverless Node functions don't provide, confirmed by the fact CI itself has to `apt-get install ffmpeg` for tests to pass.

**Recommendation: hybrid, not pure scheduled-HTTP and not "everything needs a worker":**
1. Calendar-event processing, meeting-bot orchestration, meeting intelligence, all three reconciliation routes, and operations recovery — **scheduled HTTP invocation** (platform cron calling each route on a cadence, secret header attached). Every one of these is already secret-gated, already idempotent-safe to call repeatedly (proven by M16's own CAS/idempotency tests), bounded per-invocation, and has no binary dependency. No new process needed for these.
2. **Transcription processing — a small dedicated worker/container**, specifically because of the `ffmpeg` dependency, reusing the exact environment shape CI already proves works. `bot-worker.mjs` can optionally live on the same small host for convenience, though nothing about it structurally requires that (its own domain functions are stateless between ticks, confirmed by reading the whole file).

This resolves the earlier draft's "pick (1) scheduled-HTTP for everything" recommendation, which was written before the ffmpeg dependency was specifically checked — the corrected recommendation is topology **C** in M17A's hosting-decision-analysis framing (§6 of the M17A request): not pure Vercel-only, not "everything needs a dedicated host," a hybrid grounded in the one real constraint the code actually has.

**Startup/restart behavior:** whichever shape is chosen, the health check in "production health checks" below must be able to detect "the scheduler/worker hasn't successfully ticked in N minutes" and alert via the same `operational_incidents` mechanism M16 built — a new `incidentType: "worker_stale"` fits the existing table/RLS/dedup without any schema change.

**Production health checks:**
- Web app: a simple `GET /api/health` (new, trivial — DB reachability check) for the hosting platform's own liveness probe.
- Scheduler/worker: log/alert on a non-200 response from any scheduled route. The exact result shape differs by route, not uniform across all six — the genuinely per-org routes (`operations/recover`, the three `*/reconcile` routes, `meeting-policy/evaluate`, `recording-exceptions/maintain`, and the reconcile portion of `meeting-bots/tick`) return a per-org `results`/`reconcileResults` array with a per-org `error` field (see `recover/route.ts`), while `calendar-events/process` and the drain phase of `transcription/process`/`meeting-intelligence/process` return a single aggregate result (`ProcessQueueResult`/`queueResult` — `packages/domain/src/meetings.ts:388-393`), not a per-org breakdown. Either shape alerts correctly on a non-200/thrown error; only the per-org routes can additionally pinpoint *which* org failed without extra log inspection.

## 4. Microsoft Graph

**Already built and tested:** OAuth connect flow (`packages/domain/src/microsoft-connection.ts`), webhook receiver (`apps/web/app/api/webhooks/microsoft/calendar/route.ts`), calendar sync job creation (`calendar_event_jobs`), `createSubscription`/`renewSubscription`/`deleteSubscription` in `packages/microsoft/src/graph-client.ts`.

**Real gap confirmed by reading the code, not assumed:** `renewMicrosoftSubscription` (`microsoft-connection.ts:314`) is never called from any route or worker. Graph subscriptions have a hard expiration (short — hours to a few days depending on resource type); without renewal, calendar webhook delivery silently stops mid-pilot with no user-visible error, only a growing gap in `calendar_event_jobs` creation. **This must be fixed as part of M17, not deferred** — it's exactly the kind of "queue built but never scheduled" gap §6 covers, specific to subscriptions.

**M17A confirmed the exact production requirements — see `docs/ops/production-microsoft-setup.md` for the full detail.** Summary:
- Exact required scopes, confirmed by reading `packages/microsoft/src/config.ts:31-37` directly: `openid`, `profile`, `email`, `offline_access`, `Calendars.Read` — five, delegated, read-only. Nothing else.
- Exact redirect URI, confirmed by reading the connect route: `${APP_BASE_URL}/api/integrations/microsoft/callback`.
- Exact webhook URL, confirmed by reading the callback route: `${WEBHOOK_BASE_URL}/api/webhooks/microsoft/calendar`.
- Exact subscription ceiling, confirmed by reading `packages/microsoft/src/config.ts:43-48`: `MAX_SUBSCRIPTION_MINUTES = 4230` (~70.5 hours), Graph's own cap, not ApplyWizz's choice.
- Whether ApplyWizz's Entra tenant requires admin pre-consent before employees can complete this per-user delegated flow is **tenant-policy-dependent and cannot be answered from this codebase** — confirm with ApplyWizz's Entra/IT admin before pilot go-live.

**What M17C must still verify against a REAL production app registration, not the dev one:**
- Webhook endpoint reachable at the real `WEBHOOK_BASE_URL` (§1) — Graph will not deliver notifications to `localhost` or an unreachable URL, so this genuinely cannot be verified until deployment (§3/M17B) is done.
- Webhook validation: confirm the existing `MICROSOFT_WEBHOOK_CLIENT_STATE` check in the webhook route still rejects a forged notification in production the same way `018_side_effect_denial.test.sql`-style tests proved locally.
- Subscription renewal wired into §6's scheduler (built in M17B/C per the gap above), calling the existing `renewMicrosoftSubscription` at least daily — comfortably inside the confirmed 4230-minute ceiling.
- Calendar reconciliation (`/api/internal/tenant-sync/reconcile`, `/api/internal/customer-linkage/reconcile`, `/api/internal/scheduler-linkage/reconcile`) scheduled per §6.
- Meeting join URL availability, reschedule/cancel handling: already covered by existing `calendar_event_jobs` change-type handling (`change_type` column) — verify against real reschedule/cancel events during the M17C smoke test, not just unit-tested synthetic payloads.

## 5. Vexa / meeting bot

**Already built and tested:** `VexaMeetingBotProvider` (`packages/meeting-bots/src/vexa/client.ts`), `createBot`/`cancelBot`/`getBotStatus`, idempotency via `idempotencyKey` (real provider-side dedup contract, not just our own DB check), CAS-based claim in `processPendingBotJobs` (`meeting-bots.ts:246-256`), M16's own provider-liveness check before stuck-bot recovery (`operations-recovery.ts`'s `recoverMeetingBot`).

**Duplicate-bot prevention, already proven at three independent layers** (worth restating precisely since a real pilot is the first time this matters with real external meeting participants, not synthetic test data):
1. `createBot`'s `idempotencyKey` — a repeated create call for the same key returns the same bot, never a second one (provider-level contract, `FakeMeetingBotProvider`'s own doc comment confirms this mirrors what a real provider must also guarantee).
2. `processPendingBotJobs`'s CAS claim (`.eq("status","pending").eq("retry_count", job.retry_count)`) — two workers can't both schedule the same job.
3. M16's `recoverMeetingBot` provider-liveness check — never requeues a stuck bot job without confirming the provider itself considers the session gone.

**What M17C must verify for real, not just via `FakeMeetingBotProvider`:**
- A real bot actually joins a real Teams meeting (the golden path in §12) — this is the first time in the entire project this has happened against a live Teams call, not a fake provider.
- Real provider callback/status shape matches what `getBotStatus`'s `normalizeVexaStatus` expects — confirmed correct against Vexa's documented API during M6, but a real pilot meeting is the first live-traffic confirmation.
- Recording/transcript handoff: confirm the artifact Vexa hands back is actually consumable by the existing transcription pipeline (`packages/transcription`) end to end.
- Cancel/recovery behavior against a real session (cancel a real live bot mid-meeting, confirm `cancelBot` + our own state update stay consistent).

## 6. Queue scheduling

**The core gap this checkpoint closes.** M16 built recovery/processing endpoints but explicitly did not schedule any of them (documented in the M16 runbooks and plan — this was in scope for M17 from the start). Every route below already exists, is already secret-gated, and is already safe to call repeatedly (each one's own idempotency/CAS/dedup was independently tested in M16 or earlier):

| Job | Route / process | Recommended cadence | Owner | Retry behavior | Failure visibility |
|---|---|---|---|---|---|
| Calendar-event processing | `POST /api/internal/calendar-events/process` | every 1 min | scheduler | route's own per-job `attempts`/backoff (existing, unchanged) | route already returns per-job results; alert on non-200 |
| Meeting-bot orchestration | `workers/orchestrator/bot-worker.mjs` (keep as a persistent process) or `POST /api/internal/meeting-bots/tick` on a schedule | 30s (existing `BOT_WORKER_TICK_INTERVAL_MS` default) if kept as a worker; 1 min if converted to scheduled HTTP | scheduler or worker host | existing per-queue retry/backoff, unchanged | existing per-org try/catch in the route, unchanged |
| Transcription processing | `POST /api/internal/transcription/process` | every 1–2 min | **dedicated worker/container (M17A finding — `ffmpeg`/`ffprobe` binary dependency in `audio-transcode.ts`, not compatible with a bare Vercel scheduled function; see `docs/ops/production-environment.md` §11)**, not the general scheduler | existing `MAX_RETRY_COUNT=5` backoff, unchanged | existing |
| Meeting intelligence | `POST /api/internal/meeting-intelligence/process` | every 1–2 min | scheduler | existing `MAX_RETRY_COUNT=5` backoff, unchanged | existing |
| Reconciliation (tenant-sync, customer-linkage, scheduler-linkage) | `POST /api/internal/tenant-sync/reconcile`, `.../customer-linkage/reconcile`, `.../scheduler-linkage/reconcile` | every 5–15 min (lower frequency — these are reconciliation, not the hot path) | scheduler | existing, unchanged | existing |
| Microsoft subscription renewal | **new**: a thin route or addition to an existing reconcile route calling `renewMicrosoftSubscription` per active connection | daily, well inside the real subscription expiration window confirmed in §4 | scheduler | on failure, record an `operational_incidents` row (`queue: "microsoft_subscription"`, `incidentType: "renewal_failed"`) — reuses M16's existing `recordIncident`, additive only | `/admin/operations`, same as every other M16 incident |
| Operations recovery (stuck-job sweep) | `POST /api/internal/operations/recover` | every 5 min (matches the 30-min stuck threshold with comfortable margin) | scheduler | existing CAS/bounded-retry, unchanged (M16, untouched) | existing `/admin/operations` |
| Internal recap email (§7) | new route, e.g. `POST /api/internal/recap-email/process` | every 1–2 min (should fire promptly after a meeting's intelligence completes) | scheduler | new — see §7's idempotency requirement | new incident type, `queue: "recap_email"` |

**No manual-only production queue draining** — every row above has a real scheduled caller by the end of M17B. **Owner** in production means: whichever scheduling mechanism is chosen in §3 (platform cron vs. worker process) — the specific product/person on-call for it is an organizational decision outside this plan's scope, but the *technical* "what calls what, how often" is fully specified above.

## 7. Internal post-meeting email

**Confirmed net-new work** — `packages/email/` is empty, `getEmailEnv()` is unused. Required flow, as specified:

`meeting completes → transcript/intelligence completes → internal recap generated → email to assigned AM / authorized internal owner`

**Design, following the exact pattern already established by `packages/ai`/`packages/meeting-bots`/`packages/crm`** (a provider-agnostic interface + one concrete adapter, never hard-coded into domain code):
- `packages/email/src/types.ts` — `EmailProvider` interface: `sendEmail(input: { to: string[]; subject: string; html: string; text: string; idempotencyKey: string }): Promise<{ providerMessageId: string }>`.
- `packages/email/src/fake-provider.ts` — `FakeEmailProvider`, matching `FakeMeetingBotProvider`'s in-memory, idempotency-aware shape, for tests.
- A concrete adapter — **which provider is a real open decision, not silently picked** (flagged in the checkpoint below); recommend Resend (simple REST API, generous free tier for internal-only low-volume transactional email, easy idempotency-key support via its own dedup header) as the default unless there's an existing ApplyWizz vendor relationship (Postmark/SendGrid/SES) that should be reused instead.
- `packages/domain/src/recap-email.ts` — new domain function, `generateAndSendRecap(supabase, organizationId)`: finds meetings whose `ai_runs` just completed and have no recap sent yet, builds the recap content from already-existing data (meeting summary, actions, customer truth proposals — all already produced by shipped M9/M11 work, this function only assembles and formats, doesn't compute anything new), resolves the AM + authorized manager recipient via existing `organization_memberships`/`manager_membership_id` (same reporting-line resolution `is_manager_of` already proves correct), and calls the `EmailProvider`.
- **Idempotency**: a new column or a reuse of the existing `meeting_lifecycle_events` table (already meeting-scoped, already free-text `event_type`, already used by transcription/meeting-intelligence/meeting-bots for exactly this "did this already happen" shape) — record `recap_email.sent` there and never resend for the same meeting. Simplest correct option: check for that event type before sending, matching the established pattern exactly rather than inventing a new tracking mechanism.
- **Auditable**: the same `logLifecycleEvent` call above is the audit trail — already proven, already tested pattern, no new audit infra needed.
- **Retryable**: failures don't mark the event as sent; the next scheduled tick retries. Bound retries the same way every other queue does (`MAX_RETRY_COUNT`-style ceiling) rather than retrying forever — record an `operational_incidents` row (`queue: "recap_email"`, `incidentType: "terminal_failure"`) on exhaustion, reusing M16's existing table/dedup, zero schema change.
- **Internal recipients only, enforced structurally, not just by convention**: the recipient-resolution function only ever queries `organization_memberships` (AM + their manager chain) — it has no code path that can produce a customer email address, since customer contact data isn't even in scope of that query. A customer-safe recap variant, if built, is written to a new column/table as a draft and never passed to `EmailProvider.sendEmail` — no send path exists for it in this design.

## 8. Observability

**Reuse M16's `operational_incidents` — do not build parallel infrastructure.** Every new failure mode this checkpoint needs is a new `incidentType` value on the existing table (free-text column, no migration needed for new type strings, same as `queue`/`incident_type` already are):

| New signal | `queue` | `incidentType` | Recorded by |
|---|---|---|---|
| Worker/scheduler hasn't ticked recently | `"scheduler"` | `"worker_stale"` | new: a scheduled self-check comparing `last_seen_at` on a heartbeat row against wall-clock time |
| Queue backlog (pending count above a threshold) | matches queue name | `"backlog"` | new: extend the existing operations-recovery sweep (or a sibling function) to also check pending counts, not just stuck/failed — additive to `operations.ts`/`operations-recovery.ts`, no change to existing logic |
| Microsoft subscription renewal failure | `"microsoft_subscription"` | `"renewal_failed"` | §6's new renewal route |
| Webhook validation failure (repeated, not a one-off) | `"microsoft_webhook"` | `"validation_failed"` | the existing webhook route, additive `recordIncident` call only on the reject path |
| Email send failure | `"recap_email"` | `"terminal_failure"` | §7 |

`/admin/operations` (already shipped, already tested) needs zero code change to surface these — `listOpenIncidents` already returns every open row for the org regardless of `queue`/`incidentType` value.

## 9. Backup / recovery

- **Supabase backup posture**: confirm what tier/plan the new production project is on and what its automatic backup (PITR or daily snapshot) actually provides — this is a real, project-specific fact to check at provisioning time (M17A), not something to assume from documentation.
- **Restore procedure**: document the actual `supabase db` restore steps for whatever tier is chosen, verified once against a real restore (not just read from Supabase docs) before pilot go-live.
- **Rollback deployment**: whatever hosting platform is chosen (§3) must support a one-command/one-click rollback to the previous deployed build — confirm this concretely during M17B, don't assume.
- **Disable bot joining**: already possible today with zero new code — the existing meeting-policy `eligibility_status` mechanism, or simply unsetting `VEXA_API_KEY` (the route already 501s cleanly when Vexa is unconfigured, per the M16-review-verified fallback in `recover/route.ts` and the pre-existing pattern in `meeting-bots/tick/route.ts`).
- **Disable worker processing**: stop the scheduler/worker process (§3) — no code change needed, this is purely an operational action.
- **Disable internal emails**: unset `EMAIL_PROVIDER_API_KEY` — the new email route should follow the exact same "missing config → clean skip, not a hard crash" pattern already established for Vexa, so this is a required design property of §7's implementation, not an afterthought.
- **Provider outage procedure**: already written — `docs/ops/runbooks/provider-outage.md` (M16) — verify it against the real production Vexa/OpenRouter/Microsoft endpoints during M17E's failure drills, add a fourth section for the new email provider using the same template.

## 10. Security / privacy — production checklist

- **Production secrets**: fresh values for every row in §2's table, none copied from dev, `OPENROUTER_API_KEY` fresh specifically because the dev value is documented-compromised.
- **RLS**: re-verified against the real linked production project (§1), not just local Postgres.
- **service_role boundaries**: unchanged from M15/M16 — every service_role grant in `supabase/migrations/` is already explicit-named-role-only (`revoke all ... from public, anon, authenticated` pattern, audited in M15). No new service_role grants introduced by this plan except §6's subscription-renewal route and §7's email route, both of which must follow the identical pattern.
- **SECURITY DEFINER invariant**: `019_security_definer_privilege_invariant.test.sql`'s catalog-scanning guardrail already auto-covers any new SECURITY DEFINER function — if §6 or §7 introduce one (unlikely; both are plain service_role table writes, no new SQL functions currently planned), it gets caught automatically, same as M16's `record_operational_incident` was.
- **Cross-org isolation**: unchanged — every new route in this plan follows the existing per-org loop + `.eq("organization_id", ...)` pattern, same as every `/api/internal/*` route already does.
- **Manager/reporting-line scope**: unchanged, already proven (`020_manager_customer_visibility.test.sql`) — §7's recap-email recipient resolution reuses the exact same `is_manager_of`/`manager_membership_id` mechanism, not a new authorization path.
- **Transcript access**: unchanged RLS posture from earlier milestones.
- **Incident-data minimization**: unchanged from M16 — every `reason` string is still a fixed coded literal, verified by M16's own tests; §6/§7's new incident types must follow the identical discipline (no interpolating email addresses, no interpolating meeting content).
- **Logs**: covered in §2's "no secrets in logs" sweep.
- **Retention/deletion policy — GENUINELY UNDECIDED, flagging explicitly rather than inventing one.** No retention/deletion mechanism exists anywhere in the schema (checked: no `deleted_at`, no purge job, no TTL). Before a real pilot records real customer conversations, ApplyWizz needs an actual decision: how long are transcripts/recordings kept, who can delete them, is there a legal hold requirement. **This is a business/legal decision, not a technical one — this plan does not invent an answer.**
- **Participant recording notice/consent — GENUINELY UNRESOLVED, flagging explicitly.** `apps/web/app/admin/policies/page.tsx` already contains the sentence "participant recording consent/notice is a separate concern, handled elsewhere" but nothing in the codebase implements it — no consent banner, no meeting-description injection, no verbal-notice requirement surfaced anywhere. Before a real pilot bot joins a real external-facing customer call, ApplyWizz needs to decide and implement how meeting participants are notified they're being recorded (this varies by jurisdiction — one-party vs. two-party consent). **This plan does not invent that answer or that mechanism — it is a required pre-pilot decision**, likely needing a small, real implementation (e.g., the bot's own display name already visible in the meeting — `packages/meeting-bots/src/types.ts:25`, `"Display name the bot shows as inside the meeting"` — may or may not be sufficient notice depending on the jurisdiction's legal requirement; that's a legal call, not an engineering one).

## 11. Pilot data

Recommend a **small first pilot**, not company-wide:
- **Which AMs**: 2–3 Account Managers, chosen by whoever owns the ApplyWizz pilot decision (not a technical choice this plan makes) — ideally AMs already comfortable giving fast feedback.
- **Which Manager/Admin**: the direct reporting manager for the chosen AMs, so the existing manager-visibility features (`/manager/*`, already shipped M14) get real exercise too, plus one org Admin for `/admin/operations` monitoring.
- **How many meetings**: no fixed cap — let it run for the pilot duration below and capture whatever real CRM-connected meetings those AMs naturally have; do not force volume just to hit a number.
- **Expected duration**: 2 weeks, long enough to cross at least one full Microsoft Graph subscription renewal cycle (validating §4/§6's renewal wiring under real conditions, not just at kickoff) and to naturally hit a few of the failure-drill scenarios organically.
- **Success criteria**: every meeting in scope for the pilot AMs gets a bot join/skip decision matching policy, produces a transcript + intelligence + recap email within an agreed SLA (e.g., recap delivered within 30 minutes of meeting end), zero cross-org/cross-AM visibility leaks, zero customer-facing email sent, `/admin/operations` shows no unresolved terminal-failure incidents at pilot end that weren't already understood/explained during the pilot.
- **Rollback criteria**: any confirmed cross-tenant/cross-org data leak (immediate stop), any customer-facing email sent by mistake (immediate stop), sustained (>1 day) inability to deliver recaps, or the AMs/manager reporting the tool is actively unhelpful/wrong often enough to lose trust.

## 12. End-to-end golden path (must be proven with a REAL pilot meeting, not a fake-provider test)

```
CRM/scheduler meeting (real ApplyWizz-managed customer meeting, real Teams link)
  → Microsoft calendar discovery (real webhook + real reconciliation, §4)
  → canonical meeting created (existing meetings.ts logic, unchanged)
  → bot decision (existing meeting-policy.ts eligibility check, unchanged)
  → Vexa joins the real Teams meeting (§5, first real-traffic proof in the whole project)
  → meeting captured (real recording handoff)
  → transcript (real transcription pipeline run against real audio, not the M8 eval fixtures)
  → intelligence (real meeting-intelligence run against a real transcript)
  → customer truth / action generation (existing, unchanged)
  → internal recap email delivered (§7, first real send)
  → AM sees the meeting in Signal (existing UI, unchanged)
  → Manager sees the allowed view (existing /manager/* UI, unchanged — confirms M14's manager-scope RLS holds for real production data, not just pgTAP fixtures)
  → no unauthorized visibility (confirm a DIFFERENT AM/manager outside the pilot's reporting line genuinely cannot see this meeting/customer in production, mirroring 020_manager_customer_visibility.test.sql's assertions but against real rows)
```

This is checkpoint M17F's actual deliverable — it cannot be simulated with `FakeMeetingBotProvider`/`FakeEmailProvider`, it requires one real scheduled meeting with pilot participants who know they're testing this.

## 13. Failure drills

Run each of these deliberately, in staging or carefully in production during a low-stakes window, and confirm the M16 recovery/incident machinery actually does what it's supposed to under real conditions:

| Drill | How to induce it | Expected result |
|---|---|---|
| Microsoft webhook missed | Temporarily block the webhook URL (firewall rule / pause the route) for one calendar change, then unblock | Reconciliation (`/api/internal/tenant-sync/reconcile`, scheduled per §6) picks up the missed change on its next tick — no data loss, just delay |
| Vexa unavailable | Point `VEXA_BASE_URL` at an unreachable host temporarily, or use Vexa's own sandbox/maintenance window if they offer one | Bot job stays `pending`/fails cleanly per existing retry/backoff (unchanged M6 logic); once Vexa is back, next tick recovers normally — no duplicate join (§5's three-layer guarantee) |
| Stuck transcription | Manually hold a `meeting_transcripts` row in `processing` past 30 min (same technique used to demo M16's first slice: `session_replication_role=replica` to backdate `updated_at`) | `/admin/operations` shows it stuck; `operations/recover` sweep (now scheduled per §6) recovers it within 5 min per its cadence |
| Stuck intelligence | Same technique against `ai_runs` | Same recovery path, `queue: "meeting_intelligence"` |
| Provider-check failure (bot) | Point `VEXA_BASE_URL` at an unreachable host while a bot job is genuinely stuck | M16's `provider_check_failed` incident type fires (verified fix 4 behavior) — confirm it does NOT requeue and does NOT create a duplicate join attempt, exactly as the unit tests proved, now under real network failure instead of a simulated throw |
| Queue backlog | Temporarily pause the scheduler for one queue for 15–20 min, then resume | §8's new backlog incident fires; once resumed, backlog drains and the incident auto-resolves via the existing `syncIncidentsWithCurrentState`-style resolve-on-recovery pattern |
| Internal email failure | Temporarily misconfigure `EMAIL_PROVIDER_API_KEY` | §7's retry/backoff kicks in, eventually a `terminal_failure` incident if the outage outlasts the retry ceiling — confirm no customer-facing send is ever attempted as a fallback |

## 14. Human testing

Per your instruction, every human test below is phrased as URL/Login/Action/Expected/PASS-FAIL only — nothing asking you to evaluate RLS, migrations, drift, security, idempotency, concurrency, retry logic, CI, or DB integrity (those stay Claude/Codex's job, automated and already proven at the M16 level; this plan's checkpoints re-run them against production infrastructure, not re-ask you to check them by hand).

---

## Delivery checkpoints

### M17A — Production environment + secrets

**Goal:** a real, linked, schema-verified, RLS-verified production Supabase project, and every secret in §2's table populated with fresh production values.

**Files/config likely involved:** `supabase/config.toml` (project ref link, no content change), no application code changes — this checkpoint is infrastructure + config only.

**Dependencies:** none (first checkpoint).

**Automated tests:** `supabase db diff` against the linked project (zero drift), `supabase test db --linked` (full 452-assertion pgTAP suite, expect 452/452 against real production Postgres).

**Human test:** none — this checkpoint is you (or whoever holds the Supabase/Entra/Vexa account access) provisioning accounts and handing Claude the resulting connection details/secrets to configure; there's nothing to visually check yet since nothing is deployed.

**Rollback:** delete/unlink the new Supabase project — no production traffic exists yet, zero user-facing impact.

**Definition of done:** `supabase db diff` clean against the linked project, pgTAP full suite green against it, every §2 secret has a real, fresh, non-dev-reused value recorded in the platform's secret store (not yet deployed to a running app).

---

### M17B — Deploy web/workers + queue schedules

**Goal:** the web app and worker/scheduler running in production, every §6 job actually firing on its defined cadence, `/api/health` reachable.

**Files/config likely involved:** new `apps/web/app/api/health/route.ts`; hosting-platform-specific config (exact file depends on the platform decision — e.g. `vercel.json` or a Dockerfile, TBD by the decision below); a scheduler configuration (platform cron config, or systemd/process-manager config for `workers/orchestrator/bot-worker.mjs` if kept as a persistent process).

**Dependencies:** M17A (needs real secrets to deploy with).

**Decision needed before this checkpoint can start:** hosting platform (§3) and the scheduled-HTTP-vs-persistent-worker shape (§3) — genuinely open, not silently picked by this plan.

**Automated tests:** existing CI (typecheck/lint/test/pgTAP/build) must stay green on whatever branch/PR ships this — no new test framework needed, this checkpoint is deployment plumbing around already-tested code.

**Human test:**
```
URL: <production APP_BASE_URL>/api/health
Login: none needed
Action: load the URL
Expected: a 200 response (any simple JSON body)
Reply PASS/FAIL
```

**Rollback:** hosting platform's rollback-to-previous-deploy (§9) — since M17B is the FIRST production deploy, "rollback" here effectively means "take it back down" if something's badly wrong; confirm the platform supports this before going further.

**Definition of done:** all seven §6 jobs confirmed firing on schedule (checked via each route's own logged results, or via `/admin/operations` showing fresh `last_updated` timestamps moving forward on real — even if still empty — queues), `/api/health` green, CI green on the deploying branch.

---

### M17C — Microsoft/Vexa real integration smoke

**Goal:** prove the full calendar → bot → transcript pipeline works against REAL Microsoft/Vexa production endpoints, not fakes, for one real (internal, low-stakes) meeting.

**Files/config likely involved:** new Entra app registration (external to this repo), possibly a small addition to `packages/microsoft/src/config.ts` if the production app registration's scopes differ from dev (verify first, only change if actually needed); new subscription-renewal route (§6) — likely `apps/web/app/api/internal/microsoft-connection/renew/route.ts` or an addition to an existing reconcile route, TBD during implementation based on which reads more naturally alongside the existing `microsoft-connection.ts` domain function.

**Dependencies:** M17B (needs a real deployed webhook URL for Graph to call).

**Automated tests:** new unit test for the renewal route/function (mirrors the existing `/api/internal/*` route test conventions — secret-gate check, per-org loop, error handling) — written the same TDD way as every other M16/earlier milestone route.

**Human test:**
```
URL: <production APP_BASE_URL>/integrations
Login: a real ApplyWizz account (yours or a designated internal test account)
Action: connect your own Microsoft calendar, then create a real Teams meeting with yourself and one colleague a few minutes out
Expected: within a couple minutes of the meeting starting, a bot with the configured display name joins the Teams call
Reply PASS/FAIL
```

**Rollback:** disconnect the test Microsoft connection (`/integrations` already has a disconnect action, existing feature); disable bot joining per §9 if something's badly wrong (unset `VEXA_API_KEY`, zero code change).

**Definition of done:** one real bot join against real Teams, real transcript produced, real meeting-intelligence run completes, subscription renewal route tested (can force-trigger it manually once to confirm it doesn't error, full real-cadence proof comes later in the pilot per §11's "cross one renewal cycle" success criterion).

---

### M17D — Internal recap email

**Goal:** `packages/email` built (interface + fake + one real adapter), recap generation + send wired to fire after a meeting's intelligence completes, scheduled per §6, internal-recipients-only enforced structurally.

**Files/config likely involved:**
- Create: `packages/email/src/types.ts`, `packages/email/src/fake-provider.ts`, `packages/email/src/<provider>/client.ts` (provider TBD, §7), `packages/email/package.json`.
- Create: `packages/domain/src/recap-email.ts`, `packages/domain/src/recap-email.test.ts`.
- Create: `apps/web/app/api/internal/recap-email/process/route.ts`.
- Modify: `packages/domain/package.json` (new export, same pattern as every other domain module).

**Dependencies:** M17A (needs `EMAIL_PROVIDER_API_KEY` populated); does not depend on M17C.

**Decision needed before this checkpoint can start:** concrete email provider (§7 recommends Resend as a default, confirm or override).

**Automated tests:** domain-level tests for `recap-email.ts` following the exact `fakeSupabase` + `FakeEmailProvider` pattern already established across every other domain test file this session (`operations-recovery.test.ts` etc.) — covering: recap sent once per meeting (idempotency via `meeting_lifecycle_events`), recipient resolution never includes a customer address, retry on failure, terminal-failure incident on exhaustion, correct content assembly from existing summary/actions/customer-truth data.

**Human test:**
```
URL: (your email inbox, the AM test account's inbox)
Login: none needed for this check — just check the inbox
Action: after M17C's real test meeting completes and intelligence finishes, wait for the scheduled recap job to run
Expected: a recap email arrives in the internal AM's inbox (not the meeting's external participant), containing a summary and a "View in Signal" link
Reply PASS/FAIL
```

**Rollback:** unset `EMAIL_PROVIDER_API_KEY` (§9) — clean no-op, no partial-send risk given the idempotency design.

**Definition of done:** real email delivered for the M17C test meeting, zero customer-facing send capability exists in the code (structurally, not just by testing), retry/idempotency/incident-on-failure all covered by automated tests, full gate (typecheck/lint/test/pgTAP/build) green.

---

### M17E — Observability + rollback/failure drills

**Goal:** §8's new incident types wired in, every §13 failure drill run for real and confirmed to behave as designed.

**Files/config likely involved:** additive changes to `packages/domain/src/operations.ts` (backlog check) and/or `operations-recovery.ts` (worker-stale heartbeat check) — additive only, no change to existing M16 logic/tests; additive `recordIncident` call in the webhook route's reject path.

**Dependencies:** M17B, M17C, M17D (needs everything running to drill against).

**Automated tests:** new unit tests for the backlog-check and worker-stale-check functions, same fake-client pattern as `operations.test.ts`.

**Human test:**
```
URL: <production APP_BASE_URL>/admin/operations
Login: the pilot org's Admin account
Action: load the page after each drill in §13
Expected: the relevant incident appears while the drill is active, and disappears (or shows resolved) once the drill condition is cleared
Reply PASS/FAIL
```

**Rollback:** n/a — this checkpoint is additive observability, nothing to roll back that would affect the pilot itself; a bad backlog-check could theoretically false-positive-alert, which is a data-quality nit to fix forward, not a rollback scenario.

**Definition of done:** all 7 drills in §13 run, each produces the expected incident visibility and expected recovery behavior, `docs/ops/runbooks/provider-outage.md` extended with an email-provider section.

---

### M17F — Small internal pilot

**Goal:** run §11's actual pilot — real AMs, real Manager/Admin, real ApplyWizz customer meetings, for the defined 2-week window, proving §12's golden path holds under real, unscripted conditions (not just the one controlled M17C test meeting).

**Files/config likely involved:** none expected — this checkpoint is operating the already-built system, not building anything new. Any bug found here gets its own small, targeted fix (scoped at the time, not pre-specified).

**Dependencies:** M17A–E all complete.

**Automated tests:** the full existing gate stays green throughout (any fix made during the pilot goes through the same typecheck/lint/test/pgTAP/build discipline as every prior milestone).

**Human test:**
```
URL: <production APP_BASE_URL>/home (AM view), /manager/overview (Manager view)
Login: each pilot AM's real account, then the pilot Manager's real account
Action: after a real pilot meeting happens, check both views
Expected: AM sees the meeting/recap/actions; Manager sees the allowed rollup view; neither sees anything outside their own scope
Reply PASS/FAIL
```

**Rollback:** §11's rollback criteria — any of them triggers an immediate stop: disable bot joining (§9) and/or disable the relevant AM's calendar connection, notify the pilot participants, triage before resuming.

**Definition of done:** 2 weeks elapsed, §11's success criteria met, at least one full Microsoft subscription renewal cycle crossed without a gap in calendar sync, zero unauthorized-visibility incidents, zero accidental customer-facing sends.

---

### M17G — Pilot acceptance + production signoff

**Goal:** formal go/no-go decision on expanding beyond the Phase 1 pilot, based on real pilot data, not assumptions.

**Files/config likely involved:** a short pilot-results writeup (new doc, e.g. `docs/product/m17-pilot-results.md`) summarizing what actually happened against §11's success/rollback criteria — factual, not aspirational.

**Dependencies:** M17F complete.

**Automated tests:** n/a — this is a decision checkpoint, not a build checkpoint.

**Human test:** none — this is a business decision (expand pilot / hold / roll back), made by whoever owns that call at ApplyWizz, informed by the M17F results writeup.

**Rollback:** n/a.

**Definition of done:** a written decision exists — expand (define Phase 2 scope separately, not pre-specified here), hold (extend the pilot with the same scope), or roll back (execute §9's disable paths, document why).

---

## Self-review against your spec

- **Phase 1 pilot scope** — covered (§ Phase 1 pilot scope, correctly identifies bot-policy as already-built, not new work).
- **1–14 numbered areas** — each has its own section above, every claim grounded in an actual file/grep result, not assumed.
- **Business decisions flagged, not invented**: hosting platform (§3), scheduled-vs-worker shape (§3), email provider (§7, with a reasoned default), retention policy (§10, explicitly undecided), participant consent/notice mechanism (§10, explicitly undecided), Vexa production-tier confirmation (§2), ApplyWizz scheduler API's unauthenticated-upstream blocker (§2, not fixable from this repo).
- **Checkpoints M17A–G**: each has goal/files/dependencies/automated tests/human test/rollback/DoD as required.
- **Human tests**: every one is URL/Login/Action/Expected/PASS-FAIL only, nothing asks you to evaluate RLS/migrations/drift/security/idempotency/concurrency/retry/CI/DB integrity — those stay automated (existing pgTAP/vitest suites, extended in-kind for new code in M17D/E).
- **No M16 reopening**: confirmed — every M17 touch point to M16 code (`operations.ts`, `operations-recovery.ts`, `operational_incidents`) is additive only (new incident types as free-text values, new scheduled callers of existing unchanged functions), never a modification to M16's recovery/dedup/CAS logic.

## M17A addendum (completed)

M17A (Production Environment + Secrets/Configuration Readiness) is complete as a documentation/analysis checkpoint — no production infrastructure created, no migration pushed remotely, per explicit instruction. Full detail in `docs/ops/production-environment.md`, `docs/ops/production-secrets-checklist.md`, `docs/ops/production-microsoft-setup.md`. Three findings from that work updated this document in place (see §1, §3, §4, §6 above): the hosting-topology recommendation was corrected from a blanket "scheduled HTTP for everything" to a hybrid (transcription needs a small dedicated worker/container because of its `ffmpeg` binary dependency — a constraint only found by reading `audio-transcode.ts` directly, not visible from this plan's original draft); the exact Microsoft Graph subscription ceiling (4230 minutes) and exact scope/redirect/webhook URLs were confirmed; and a new pre-pilot blocker was found — Supabase Auth SMTP is unconfigured and no page exists to consume Supabase's invite-link redirect, meaning no real production user can currently be provisioned until M17B/F resolves both.
