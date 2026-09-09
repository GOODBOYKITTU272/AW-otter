# Production Environment Readiness (M17A)

Status: **planning/documentation only — no production infrastructure has been created, no migration has been pushed to any remote project.** Every claim below was checked against the actual repository (`supabase/config.toml`, `supabase/migrations/`, `apps/web/env/*.ts`, route/domain source) as of `main` @ `948b7c7413e01bf183e5179ecd09e5fe1afc2678` (M16 shipped), not assumed.

## 1. Current state (ground truth)

- No remote Supabase project is linked to this repo (`supabase migration list` → `LegacyProjectNotLinkedError`, established fact carried through M12–M16). Everything to date has run against the local Supabase stack (`project_id = "AW_otter"` in `supabase/config.toml`) plus CI's own ephemeral local stack.
- `supabase/config.toml`'s `[auth]` section is entirely local-dev-shaped: `site_url = "http://127.0.0.1:3000"`, `additional_redirect_urls = ["https://127.0.0.1:3000"]`, and `[auth.email.smtp]` is commented out/disabled (local dev uses Inbucket, a fake mail catcher — real emails are never sent locally).
- 51 migrations exist under `supabase/migrations/`, from `20260906020001_extensions_and_enums.sql` through `20260912160001_operational_incidents.sql` (the M16 migration — the newest on `main`). Full list captured below.

## 2. Required project settings for a new production Supabase project

- **A genuinely separate project** — not a reuse of the local/dev project, not a fork of it. Do not point production at the current local/dev project (per explicit instruction).
- **Postgres major version 17**, matching `supabase/config.toml`'s `[db] major_version = 17` — confirm the new project is provisioned on the same major version so migration behavior matches what's been tested all session.
- **`api.max_rows = 1000`** — already the configured cap in `[api]`; carry the same value into project settings (or confirm the Supabase Cloud default matches) so PostgREST responses stay bounded the same way locally-tested code assumes.
- **`extra_search_path = ["public", "extensions"]`** — same as local; several migrations rely on `pgcrypto`/`pgtap`-style extensions living in `extensions` and being reachable without schema-qualifying every call.
- **Auth — real values, not local placeholders:**
  - `site_url` → the real production `APP_BASE_URL` (§ below), not `127.0.0.1`.
  - `additional_redirect_urls` → the real production domain(s), HTTPS only.
  - **SMTP must be enabled and configured.** This is a genuine, previously-undocumented requirement discovered while researching this checkpoint: `scripts/bootstrap-admin.mjs`'s own comment states *"In production this sends a real invite email (via Supabase Auth's configured SMTP) so the operator never handles the Admin's password"* — it calls `supabase.auth.admin.inviteUserByEmail(...)` on the non-`--local` path. Without SMTP configured on the production project, **no production user (Admin, Manager, or AM) can ever be invited/provisioned** — the invite email would silently never send. This blocks all of M17B/F user provisioning, not just a nice-to-have.
  - **A real gap found alongside this, flagged for M17B/D, not fixed here** (out of M17A's documentation-only scope): nothing in `apps/web/app` handles the Supabase invite/recovery redirect at all — no page consumes the `#access_token=...&type=invite` fragment Supabase's invite link produces to let a newly-invited user set their initial password. `apps/web/app/login/page.tsx` only implements `signInWithPassword` against an *already-set* password. **Before any real production user is invited, either this page needs to exist, or `bootstrap-admin.mjs --local`'s "create with a known password, communicate it out of band" path needs to become the deliberate production process instead.** This is a genuine open item for M17B, documented here because it was only discovered during this checkpoint's research — not invented, not silently deferred without a paper trail.
  - `email_sent` rate limit (`[auth.rate_limit] email_sent = 2` per hour, local default) — confirm this is sufized for a small pilot's invite volume (2-3 AMs + 1-2 managers = well under 2/hour if invites are staggered; would need raising for anything bigger).
- **Backup configuration that must be enabled**: confirm and enable Point-in-Time Recovery (PITR) or the project tier's equivalent automatic backup — this is a Supabase Cloud project-tier setting, not something expressible in `supabase/config.toml` (that file only configures local dev). **Genuinely project-specific — verify what the actual provisioned tier offers at setup time, do not assume a specific backup window without checking.**
- **Network restrictions** (`[db.network_restrictions]`, disabled locally): decide whether to restrict production DB connections to known IPs (the hosting platform's egress ranges, if static/known) — a real hardening option once the hosting decision (§6) is made, not before.

## 3. Required environment variables

See `docs/ops/production-secrets-checklist.md` for the full classified inventory. Summary here: every server-only secret this app already reads is gated by `required()` in `apps/web/env/server.ts` (throws immediately if unset — verified by reading the whole file, not sampled) — there is no variable that silently falls back to an insecure default in production.

## 4. Migration sequence

Applied in the exact order below (the order `supabase/migrations/` sorts to, which is the order `supabase db push`/`migration up` always applies them in — filename-timestamp-ordered, not something to reorder):

```
20260906020001_extensions_and_enums.sql
20260906020002_organizations_and_profiles.sql
20260906020003_roles_and_permissions.sql
20260906020004_organization_memberships.sql
20260906020005_row_level_security.sql
20260906020006_tighten_default_grants.sql
20260906020007_departments_and_teams.sql
20260906020008_membership_department_team.sql
20260906020009_hierarchy_validation.sql
20260906020010_m2_rls.sql
20260906020011_audit_events_minimal.sql
20260906020012_microsoft_integration_tables.sql
20260906020013_microsoft_integration_rls.sql
20260906020014_tighten_m3_default_grants.sql
20260906020015_grant_service_role_access.sql
20260906020016_tighten_m2_default_grants.sql
20260906020017_meeting_tables.sql
20260906020018_meeting_tables_rls.sql
20260906020019_meeting_visibility_fields.sql
20260906020020_grant_service_role_calendar_connections.sql
20260906020021_meeting_dedupe_and_tenant_tables.sql
20260906020022_meeting_dedupe_and_tenant_rls.sql
20260906020023_meeting_policy_tables.sql
20260906020024_is_manager_of.sql
20260906020025_meeting_policy_rls.sql
20260906020026_meeting_policy_bootstrap.sql
20260906020027_meetings_manager_scope_rls.sql
20260906020028_memberships_manager_scope_rls.sql
20260907030001_meeting_bot_tables.sql
20260907030002_meeting_bot_rls.sql
20260908040001_customer_context_tables.sql
20260908040002_customer_context_rls.sql
20260908040003_meeting_customer_linkage_columns.sql
20260908050001_scheduler_calls_table.sql
20260908050002_scheduler_calls_rls.sql
20260908050003_scheduler_call_meeting_claim_function.sql
20260908060001_transcription_tables.sql
20260908060002_transcription_rls.sql
20260908060003_transcription_complete_job_function.sql
20260908070001_meeting_intelligence_tables.sql
20260908070002_meeting_intelligence_customer_truth.sql
20260908070003_meeting_intelligence_rls.sql
20260909080001_customer_truth_action_columns.sql
20260909080002_customer_truth_confirm_reject.sql
20260909080003_call_record_lifecycle.sql
20260909090001_customer_context_snapshots.sql
20260910100001_scheduler_calls_manager_scope.sql
20260911150001_revoke_calendar_event_job_public_execute.sql
20260911150002_revoke_more_queue_claim_public_execute.sql
20260911150003_revoke_complete_transcription_job_public_execute.sql
20260912160001_operational_incidents.sql
```

Three of these (`20260911150001`–`3`) are **security-hardening revoke migrations** from the M15 audit — they must apply in order after the functions they harden, which the timestamp ordering already guarantees; nothing project-specific to configure.

## 5. Migration history expectations

- **Apply the full sequence above in one initial push** (`supabase db push` against the newly-linked project, or `supabase migration up --linked`) — do not cherry-pick or skip any, and do not attempt to apply them against a project that already has a differently-shaped schema (this must be a fresh project).
- After the initial push, `supabase migration list` (linked) should show every migration above as applied, matching `main`'s migration directory exactly, with no local-only migration missing from the remote and no remote-only migration absent locally.
- **From this point forward, the established discipline (proven across M12–M16) applies unchanged**: every future schema change is a new timestamped file under `supabase/migrations/`, applied to production only after `supabase db diff` shows zero unintended drift locally first.

## 6. RLS verification procedure

Exactly the procedure already used and proven all session, run against the **linked production project** instead of local-only, for the first time:

```
supabase link --project-ref <production-ref>
supabase db diff                    # expect "No schema changes found" after the initial push
supabase test db --linked           # full pgTAP suite — expect 452/452, the exact count already green on main
```

This is the first time this repository's pgTAP suite will run against a real (non-local-Postgres-container) Supabase project — a genuine, not-yet-performed verification, worth treating as a real checkpoint gate rather than assuming local-green implies remote-green.

## 7. SECURITY DEFINER invariant

`supabase/tests/database/019_security_definer_privilege_invariant.test.sql` is a **self-verifying, catalog-driven guardrail** — it queries `pg_proc`/`has_function_privilege` directly for every non-trigger `SECURITY DEFINER` function in `public` and fails if `anon`/`authenticated` can execute one that isn't on its small, explicit, reviewed allowlist (`docs/security/m15-security-definer-matrix.md`). Running `supabase test db --linked` (§6) automatically re-runs this against production — no separate manual step needed, and no way for a forgotten `revoke` on a new production-only function to go unnoticed.

## 8. Schema drift verification

`supabase db diff` against the linked production project, run:
- immediately after the initial migration push (expect clean),
- before every future migration is applied to production (standard discipline, unchanged from M12–M16),
- as part of this checkpoint's own verification pass (§ Verification, below) — run locally only for now, since no project is linked yet.

## 9. Production Auth configuration

Covered inline above (§2) — restated for completeness against the checklist headings requested:
- Real `site_url`/`additional_redirect_urls` pointing at the production domain.
- SMTP configured and enabled (blocks all user invites otherwise — see §2).
- `enable_signup` can likely stay `true` at the Supabase Auth level (self-signup is irrelevant here since this app has no public signup flow — `bootstrap-admin.mjs`'s own comment: *"there is no in-app 'make me admin' endpoint"* — but this is a Supabase project-level toggle, not an app-level gate, worth setting explicitly rather than leaving at whatever the Cloud default is).
- `minimum_password_length` / `password_requirements`: confirm these meet whatever ApplyWizz's actual internal password policy is (not specified anywhere in this repo — a legitimate small business decision, default (6, no complexity requirement) is likely too weak for a production tool handling customer data; recommend raising to at least 12 with `lower_upper_letters_digits`, but this is a policy call, not purely technical).

## 10. Production redirect URLs

- Supabase Auth `site_url`/`additional_redirect_urls` → production `APP_BASE_URL`.
- Microsoft/Entra OAuth redirect URI → see `docs/ops/production-microsoft-setup.md` (separate document, per deliverable list).
- `WEBHOOK_BASE_URL` (Microsoft Graph calendar webhook) → must be the real, stable, HTTPS-reachable production URL; Graph cannot deliver notifications to `localhost` or an unreachable address, so this genuinely cannot be smoke-tested until the app is actually deployed (M17B/C), only documented as a requirement now.

## 11. Hosting-runtime analysis (do not deploy yet — analysis only)

**Question asked: can this system safely run on Vercel + Supabase + scheduled HTTP/cron invocations, with no persistent worker host?** Answered by inspecting the actual code, not by preference.

### What was actually checked

- **No `runtime`/`maxDuration`/`dynamic` export exists anywhere under `apps/web/app/api`** (`grep -rn "export const runtime\|export const maxDuration\|export const dynamic"` → zero matches) — every route runs on whatever the platform's default Node.js function limits are; none has been tuned or even considered yet.
- **No WebSocket, `EventSource`, or persistent-connection code exists anywhere in `apps/web`, `packages/domain`, `packages/meeting-bots`, or `packages/microsoft`** (checked directly, not sampled). The one `Stream` hit found (`packages/meeting-bots/src/vexa/recordings.ts`) is a comment about bounded byte-counted downloading, not a persistent connection.
- **Every `/api/internal/*` route's per-invocation work is bounded**, read directly from each route file:
  - `transcription/process` and `meeting-intelligence/process` both cap their queue drain at a **hardcoded batch of 5** per call (`processTranscriptionQueue(serviceRoleClient, deps, 5)` / `processIntelligenceQueue(serviceRoleClient, deps, 5)`) — not unbounded.
  - `calendar-events/process` is **not** a per-org loop — it makes a single call to `processCalendarEventQueue(serviceRoleClient, {...})`, which is its own **single global bounded claim loop** (`packages/domain/src/meetings.ts:408-416`: `for (let i = 0; i < maxJobs; i += 1)`, `maxJobs = options.maxJobs ?? 20`; the route doesn't override it, so it runs at the default of 20 per invocation).
  - The three `*/reconcile` routes, `meeting-policy/evaluate`, `recording-exceptions/maintain`, and `operations/recover` genuinely loop **once per active organization**, each iteration doing bounded DB reads/writes.
  - `meeting-bots/tick` is a hybrid, not a single shape: `reconcileOrganizationMeetingBots` runs **once per active organization** (a real per-org loop), while `processPendingBotJobs` and `syncBotStatuses` are each called **once, globally**, after that loop — the same "per-org for one piece, one global bounded call for another" pattern the transcription/meeting-intelligence routes use for their enqueue-vs-drain split.
  - No route loops over an unbounded global row set without either an org boundary or an explicit batch cap.
- **One real, concrete constraint found: `packages/domain/src/transcription.ts:216` unconditionally calls `transcodeToOpusOgg` for every transcription job**, and `packages/domain/src/audio-transcode.ts:77,127` shells out to the **system `ffmpeg`/`ffprobe` binaries directly** (`spawn`-style child process, not an npm-bundled library). `.github/workflows/ci.yml` has to explicitly `apt-get install ffmpeg` for tests to pass — confirming this is a real OS-level binary dependency, not something that "just works" in a generic Node.js serverless function. Standard Vercel Node.js serverless functions do not ship ffmpeg pre-installed.
- **`workers/orchestrator/bot-worker.mjs` is the only code in this repo written as a persistent process** (`while (true)` + `setTimeout` loop, `workers/orchestrator/bot-worker.mjs:77-88`). Read in full: every tick calls the exact same stateless domain functions the on-demand `/api/internal/meeting-bots/tick` route already calls, reading fresh from Supabase/Vexa each time — **no in-memory state is carried between ticks**. This confirms the loop shape is a deployment/convenience choice from M6, not a functional requirement — the same work is already exposed as an ordinary on-demand HTTP route.

### Answers to the specific questions asked

- **Is queue processing bounded per invocation?** Yes, every route — batch caps or per-org loops, verified above, not assumed.
- **Does any worker need to stay alive continuously?** No code requires it structurally. `bot-worker.mjs`'s loop is a convenience wrapper around stateless, individually-callable functions.
- **Can requests exceed serverless execution limits?** For every queue except transcription: unlikely — each unit of work is a bounded DB/HTTP call, not a long-running computation. **For transcription specifically: plausible and a real risk** — 5 sequential real audio-transcription network calls (OpenRouter STT) plus a real `ffmpeg` transcode per job, in one HTTP request, can add up to real wall-clock time for anything beyond very short clips, and standard serverless execution ceilings (commonly tens of seconds to a few minutes depending on hosting tier — verify the exact current limit against whatever plan/tier is actually provisioned, don't assume a specific number without checking at setup time) are a genuine risk for this one route.
- **Does bot orchestration require persistent runtime?** No — `createBot`/`getBotStatus`/`cancelBot` are ordinary bounded HTTP calls to Vexa; the bot joining/recording happens asynchronously on Vexa's own infrastructure, not inside our request handler. Confirmed by reading `packages/meeting-bots/src/vexa/client.ts` — every method is a single bounded `fetch`, no polling-within-a-request, no long-lived socket.
- **Does background work survive request termination?** Not applicable in the way that matters here — nothing in this codebase starts async work and returns before it completes (no fire-and-forget `setTimeout`/detached promise inside a route handler was found). Each route awaits its bounded work fully before responding.
- **Can cron invocations safely process all existing queues?** Yes for six of the seven job types in `m17-plan.md` §6's table. **No, not safely as currently written, for transcription specifically** — the `ffmpeg` binary dependency is the blocker, not request duration alone.

### Recommendation: **C — a hybrid topology, not pure A or pure B**

Not chosen from preference — chosen because the evidence above is genuinely mixed, not uniform:
- **Six of seven job types** (calendar-event processing, meeting-bot orchestration, meeting intelligence*, reconciliation ×3, operations recovery) have no OS-binary dependency and bounded per-invocation work — these fit **Option A (Vercel scheduled/cron HTTP invocation)** cleanly, no persistent host needed.
  - *meeting-intelligence has no binary dependency of its own, but confirm during M17C smoke testing that its real per-job LLM-call latency (against production data, not test fixtures) stays comfortably inside whatever execution ceiling the chosen plan/tier provides.
- **Transcription processing is the one exception**, purely because of the unconditional `ffmpeg`/`ffprobe` dependency in `audio-transcode.ts` — this needs a runtime where those binaries exist. Two real options, not a guess:
  1. A small dedicated worker/container for transcription specifically (matches exactly what CI already proves works — `apt-get install ffmpeg` — lowest-risk, most proven path), **or**
  2. Bundle a static ffmpeg binary into a Vercel function for that one route (e.g. an `ffmpeg-static`-style package) — technically possible on Vercel but genuinely untested by this codebase; would need a real spike/proof-of-concept before trusting it for the pilot, not assumed to work.
- **Recommendation for M17B: start with (1)** — one small dedicated worker/container running the transcription-processing tick (and, since it's already a proven persistent-process pattern, the existing `bot-worker.mjs` can optionally live there too, though it doesn't strictly need to) — while everything else runs as Vercel scheduled functions. This is the lowest-risk path because it reuses the exact environment shape CI already proves works, rather than betting the pilot on an unproven serverless-ffmpeg spike.

**This recommendation is carried forward into `docs/product/m17-plan.md` §3/§6** (see the diff/update note at the end of that document).

## Verification run for this checkpoint (fresh, local — no remote project exists yet)

See the top-level M17A report for full output — summarized here: `supabase db diff` (local) → "No schema changes found"; `supabase test db --local` → 452/452 pass, including `019_security_definer_privilege_invariant.test.sql`. No migration was added or changed by M17A — confirmed no migration needed for this checkpoint.
