# M16 — Reliability/Operations: Core Readiness Plan

Scope: the three remaining M16 slices (A: stuck-job auto-recovery, B:
operational alerting, C: runbooks). The first M16 slice (read-only
stuck/failed visibility, `packages/domain/src/operations.ts` +
`/admin/operations`) already shipped (SHA `e2b6195`) and is NOT touched
by this plan except by being extended (Slice B adds a section to that
same page).

No new product features, no UI redesign. Every write in this plan goes
through `service_role` from a new secret-gated `/api/internal/*` route,
matching the established queue-worker pattern exactly — it never becomes
a browser-facing bypass, because nothing here is reachable by a normal
user session.

## 1. Real inventory (read from the actual code, not assumed)

Every one of the four queues from the first slice already has its own
retry/backoff for **caught** exceptions:

| Queue | Table | Active state(s) | Retry field | Max attempts | Backoff | Claim pattern |
|---|---|---|---|---|---|---|
| Calendar sync | `calendar_event_jobs` | `processing` | `attempts` | `maxAttempts` (meetings.ts) | `nextRunAt`: `30s * 2^attempts`, capped 30min | `set status='processing' ... for update skip locked` inside one function (`claim_next_calendar_event_job`) |
| Transcription | `meeting_transcripts` | `processing` | `retry_count` | `MAX_RETRY_COUNT = 5` | `retryBackoff`: `30s * 2^n`, capped 30min | same shape, `claim_next_transcription_job` |
| Meeting intelligence | `ai_runs` | `running` | `retry_count` | `MAX_RETRY_COUNT = 5` | same formula | `claim_next_meeting_intelligence_run` |
| Meeting bot | `meeting_bot_jobs` | `scheduled`, `joining` | `retry_count` | no fixed ceiling on the schedule-claim path; the schedule-attempt path retries only on a duck-typed rate-limit shape, else fails immediately (`processPendingBotJobs`, meeting-bots.ts:340-402) | provider `retryAfterSeconds` when present | CAS: `.eq("status","pending").eq("retry_count", job.retry_count)` then check a row came back |

**The real, confirmed gap (already identified and documented in the first
slice): none of the four have any mechanism to notice a row that a
worker claimed (flipped to processing/running/scheduled/joining) and then
never finished — because the process crashed, timed out, or was killed
before ever reaching its own `catch` block.** That row's `retry_count`
never increments, no `error_code` is ever set, and it sits in an active
state forever, invisible to everything built so far. This is exactly
what Slice A fixes — nothing else.

Existing precedent I'm reusing, not inventing:
- **CAS claim pattern** (`meeting-bots.ts:246-256`): `update ... where
  status = <expected> and retry_count = <expected> returning id`, then
  check whether a row actually came back. This is exactly how two
  concurrent recovery sweeps can't both recover the same row — copied
  verbatim for the recovery function's own claim step.
- **`logLifecycleEvent`** (`meeting-bots.ts:11`, table
  `meeting_lifecycle_events`, `event_type text not null` — free text, no
  enum, no migration needed to add new event types like
  `transcript.recovered_from_stuck`). Only covers meeting-scoped queues
  (transcription, meeting intelligence, meeting bot) — `calendar_event_jobs`
  has no `meeting_id` and isn't meeting-scoped, so it keeps using its own
  `last_error`/`attempts` columns as its own trail, same as today.
- **Existing retryable/non-retryable precedent**
  (`meeting-bots.ts:354-402`): the bot-scheduling path already
  distinguishes a duck-typed rate-limit error (retry) from everything
  else (immediate `failed`, no retry loop at all) — proving this
  codebase already has a real convention for "don't blindly retry
  everything," not something Slice A has to invent from scratch.

**Explicitly NOT changed by this plan**: the existing `catch` blocks in
`transcription.ts`, `meeting-intelligence.ts`, `meeting-bots.ts`,
`meetings.ts` — their own retry/backoff/terminal logic for errors they
actually catch is already correct and already tested. Slice A adds a
parallel, additive recovery path for the case those `catch` blocks never
run at all. One real, disclosed gap this leaves open (documented, not
fixed): `IntelligenceApiError` carries a real HTTP `.status` (e.g. 401 —
a bad API key, which will never succeed on retry) but
`meeting-intelligence.ts`'s `classifyError` currently maps every
`IntelligenceApiError` to the same generic `intelligence_failed` code and
retries it up to `MAX_RETRY_COUNT` regardless. Fixing that means editing
shipped M9 catch-block logic — a real, separate, higher-risk change
outside "stuck-job recovery," noted here as backlog, not silently
dropped.

## 2. Slice A — Stuck job auto-recovery

### 2.1 Stuck threshold (reused, not re-decided)

Same `STUCK_THRESHOLD_MINUTES = 30` constant already shipped in
`operations.ts`. One constant, one place, already has its own
`ponytail:`-style comment about being a first-pass value to revisit with
real operational data — not re-litigated here.

### 2.2 Retry eligibility / classification

For a row **detected stuck** (active state, `updated_at` older than the
threshold — the exact same query `operations.ts` already runs):

- **Exhausted** (non-retryable): `retry_count >= MAX_RETRY_COUNT` (5, for
  transcription/meeting-intelligence; calendar sync's own `maxAttempts`;
  meeting bot has no claim-side ceiling today — capped at the same `5`
  for its recovery path specifically, since an unbounded stuck-recovery
  retry loop would be a real new bug this plan must not introduce) → mark
  **terminal** (`failed` / `dead_letter`), record an incident (Slice B),
  never retried again.
- **Retryable** (everything else): the only signal a genuinely-stuck row
  carries is "a worker claimed this and never finished" — there is no
  caught error to classify further (that is the whole reason it's stuck:
  nothing was ever caught). Recover it the same way an existing caught
  transient failure is recovered: bump `retry_count`, set
  `next_retry_at` via the exact same backoff formula already in each
  file, revert status to the queue's own "will be picked up again" state
  (`retryable`/`pending` — matching what the existing catch blocks
  already do), set `error_code` to a new value —
  **`worker_stuck_timeout`** — so the audit trail honestly shows this was
  detected by the recovery sweep, not a caught application error.

This intentionally does **not** attempt to distinguish "provider was
down" from "our own process crashed" for the stuck case, because nothing
in a stuck row's data lets it distinguish those — both look identical
from outside (claimed, then silence). Treating "stuck" itself as the
signal, bounded by the same `MAX_RETRY_COUNT` every other path already
respects, is the safe, conservative, already-precedented choice.

### 2.3 Idempotency / concurrency safety (the actual hard requirement)

The recovery **claim** for a stuck row uses the identical CAS shape
already proven in `meeting-bots.ts`:

```
update <table>
set <active-state-field> = <recovered-value>, retry_count = retry_count + 1, ...
where id = <row.id>
  and organization_id = <row.organization_id>
  and <status-field> = <row's exact currently-observed active status>
  and updated_at = <row's exact currently-observed updated_at>
returning id
```

If the original worker actually finishes (or fails, or another recovery
sweep already recovered it) between the read and this update, the
`updated_at`/`status` in the `where` clause no longer match, the update
affects zero rows, and the recovery step for that row is silently a
no-op — this is what makes "repeated recovery invocation is idempotent"
and "two workers cannot both recover the same job" true by construction,
not by a separate lock table. Same reasoning `meeting-bots.ts`'s own
comment gives for its own claim.

### 2.4 Where this runs

New route: `/api/internal/operations/recover/route.ts` — same
`x-internal-queue-secret` gate as every other `/api/internal/*` route
(`validateState`, timing-safe, fail-closed on missing secret — the exact
pattern already audited in M15). Calls one new domain function per queue
in `packages/domain/src/operations-recovery.ts` (kept separate from the
read-only `operations.ts` since this file does writes with
`service_role`, a meaningfully different trust level worth keeping in its
own file rather than blurring into the read-only module). No new
migration required for Slice A itself — it only writes columns that
already exist.

### 2.5 Cross-org isolation

The recovery sweep processes one organization at a time (mirrors
`enqueuePendingIntelligenceRuns`/`processCalendarEventQueue`'s existing
per-org-loop shape in the internal routes) — the `.eq("organization_id",
...)` filter is present on every read and every CAS update, so a stuck
row in org A can never be matched or recovered by a sweep scoped to org
B. Verified with a dedicated pgTAP/unit test (below), not just asserted.

## 3. Slice B — Operational alerting

### 3.1 New table: `operational_incidents` (one additive migration)

```sql
create table public.operational_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  queue text not null,                    -- 'calendar_sync' | 'transcription' | 'meeting_intelligence' | 'meeting_bot' | 'reconciliation'
  entity_id text not null,                -- the job/run row id, or a reconciliation-run identifier
  incident_type text not null,            -- 'stuck' | 'terminal_failure' | 'provider_check_failed' | 'reconciliation_failure' | 'repeated_provider_failure'
  severity text not null,                 -- 'warning' | 'critical'
  reason text not null,                   -- short, safe, coded text ONLY — never transcript/CRM content
  meeting_id uuid references public.meetings (id) on delete set null,
  occurrence_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The actual dedup mechanism: one OPEN row per (org, queue, entity, type).
-- A recurring incident after resolution gets a NEW row (fresh alert) —
-- enforced by including resolved_at's "is null" state via a partial
-- unique index, the standard Postgres idiom for "unique among the open
-- ones only."
create unique index operational_incidents_open_dedup_uq
  on public.operational_incidents (organization_id, queue, entity_id, incident_type)
  where resolved_at is null;
```

RLS: `operational_incidents_select_admin_org` — `private.is_org_admin()
and organization_id = private.current_organization_id()`, `to
authenticated`, mirroring `calendar_event_jobs_select_admin_org` exactly.
No `service_role`-only lockdown needed on SELECT (this is genuinely
admin-visible operational data, same posture as the four job tables
already are for admins) — only INSERT/UPDATE stay `service_role`-only
(the write side is worker infrastructure, not something any browser
session should ever mutate directly).

### 3.2 `recordIncident` (upsert, the actual dedup logic)

**As shipped** (revised after independent review flagged the original
sketch's read-then-write `occurrence_count` as a lost-update risk under
real concurrency): `recordIncident` is a thin wrapper around ONE call to
`public.record_operational_incident`, a SECURITY DEFINER SQL function
(service_role-only, explicit revoke/grant matching the `claim_next_*`
precedent) that does the whole insert-or-bump in a single atomic
statement:

```sql
insert into public.operational_incidents (organization_id, queue, entity_id, incident_type, severity, reason, meeting_id)
values (p_organization_id, p_queue, p_entity_id, p_incident_type, p_severity, p_reason, p_meeting_id)
on conflict (organization_id, queue, entity_id, incident_type) where resolved_at is null
do update set occurrence_count = operational_incidents.occurrence_count + 1, last_seen_at = now();
```

The `on conflict` target repeats the partial unique index's exact
predicate, so Postgres uses it as the arbiter. This replaces the original
select-then-branch sketch entirely — no separate 23505-catching insert
path needed, since ON CONFLICT already handles the race in one round
trip. See `packages/domain/src/operational-incidents.ts` and
`supabase/tests/database/022_operational_incidents_dedup_and_bump.test.sql`.

### 3.3 `resolveIncidents`

Called at the end of the recovery sweep for every row in a queue that is
**no longer** in a failed/stuck state: `update operational_incidents set
resolved_at = now() where organization_id = ... and queue = ... and
entity_id = ... and resolved_at is null`. This is what makes "resolved
then recurring incident can alert again" true — the next `recordIncident`
call for the same key finds no open row (the old one has
`resolved_at` set) and inserts a fresh one.

### 3.4 What calls `recordIncident`

**As shipped** (revised after independent review flagged the original
design as double-alerting on exhaustion): `recoverStuckJobs` (the sweep)
records `stuck` when it successfully recovers a non-terminal row, and
`provider_check_failed` when a meeting-bot's provider-liveness check
itself fails (see recoverMeetingBot in operations-recovery.ts). It deliberately does NOT record anything when
a row exhausts retries and goes terminal — it only flips the row's state.
`syncIncidentsWithCurrentState`, called right after in the same request,
is the ONE canonical source of `terminal_failure` incidents: it
independently re-reads every row's current state and records/resolves
based on what it finds, regardless of whether the sweep, a normal
catch-block, or anything else put a row into that state. The original
design had BOTH functions record an incident for the same exhaustion
event under two different `incident_type` labels — fixed to one canonical
source. This keeps incident-recording centralized in the one new sweep +
sync pair, rather than touching the four existing worker files'
success/catch paths at all.
Reconciliation-failure incidents (customer-linkage / scheduler-linkage /
tenant-sync `/api/internal/*/reconcile` routes) are recorded the same
way, from the sweep noticing their own job tables' failure state — no
new instrumentation inside those three reconcile functions themselves.

### 3.5 Surfacing

`/admin/operations` (already shipped) gains one more section: "Open
incidents" — reads `operational_incidents` via the caller's own client
(new RLS policy above), shows queue/type/severity/reason/first-last-seen/
occurrence count. No email/Slack delivery in this slice — no existing
outbound-alert infrastructure exists in this codebase to hook into (only
Inbucket, a **local dev-only** SMTP test double, confirmed via
`supabase/config.toml`), and standing up a real one is a distinct,
larger decision explicitly out of scope ("prefer existing infra... a
simple internal/admin operational surface is enough if external delivery
is not already available" — it is not available, so this is the
deliberate stopping point).

## 4. Slice C — Runbooks

`docs/ops/runbooks/*.md`, one file per scenario, each with Symptom /
Likely cause / Diagnostic command / Safe remediation / Verification
command / Escalation condition, using this repo's real table names,
real `docker exec ... psql` invocations (the pattern used throughout
this session's own debugging), and the real internal endpoints:

1. `stuck-transcription-job.md`
2. `stuck-meeting-intelligence-run.md`
3. `provider-outage.md` (Vexa / OpenRouter / Microsoft Graph)
4. `webhook-reconciliation-failure.md`
5. `queue-backlog.md`
6. `repeated-terminal-failures.md`
7. `recovery-after-provider-returns.md`
8. `verify-no-duplicate-side-effects.md` — leans on the real unique
   constraints already in the schema (`meeting_transcripts_org_meeting_uq`,
   `ai_runs_identity_uq`, `meeting_bot_jobs`' idempotency_key,
   `calendar_event_jobs_pending_dedupe_uq`) as the actual verification
   queries, not new tooling.

## 5. Test plan (mapped directly to the required list)

- `packages/domain/src/operations-recovery.test.ts` (fakeSupabase, same
  convention as every other domain test this session):
  - eligible stuck job (active state, stale `updated_at`, `retry_count <
    MAX`) is recovered: status reverts, `retry_count` bumped,
    `next_retry_at` set, `error_code = 'worker_stuck_timeout'`.
  - a recently-updated active row (not stale) is left completely
    untouched.
  - an exhausted row (`retry_count >= MAX`) found stuck goes straight to
    terminal, is never retried.
  - a row already in a non-active state (already `completed`/`failed`)
    is never touched by the sweep at all.
  - **idempotency**: running the sweep twice in a row against the same
    fixture only recovers each eligible row once (second pass sees the
    now-non-stale/non-active row and no-ops) — models the CAS `where`
    clause directly in the fake.
  - **concurrent claim**: two simulated concurrent sweep calls against
    the same stuck row — only one succeeds in claiming it (fake models
    the CAS row-count-affected semantics), the other observes zero rows
    updated.
  - cross-org: a stuck row in org B is never touched by a sweep scoped to
    org A, and vice versa.
- `packages/domain/src/operational-incidents.test.ts`:
  - a new incident emits exactly one row.
  - a second call with the same dedup key while still open only bumps
    `last_seen_at`/`occurrence_count`, never inserts a second row.
  - resolving an incident then recording the same key again creates a
    genuinely new row (fresh alert), not a bump of the resolved one.
  - `reason`/payload fields are asserted to never contain a literal
    transcript/CRM-shaped string (a fixture including one proves it's
    never passed through).
- pgTAP: `operational_incidents` RLS (admin-org-only select, cross-org
  denied, non-admin denied) — same shape as `020_manager_customer_visibility.test.sql`.
- Fresh `supabase test db --local` (full suite), `supabase db diff`
  (zero unintended drift beyond the one new migration), typecheck, lint,
  build.

## 6. Explicitly deferred (not silently dropped, written down)

- Real non-retryable classification for *caught* provider errors (e.g.
  HTTP 401 from OpenRouter) — a change to already-shipped M9 catch-block
  logic, separate and riskier than stuck-job recovery.
- External alert delivery (email/Slack/PagerDuty) — no existing
  production-capable channel to hook into.
- Per-queue-tuned stuck thresholds (currently one shared 30-minute
  constant, inherited from the first M16 slice).
- A UI "resolve this incident" action — this slice surfaces incidents
  read-only; resolution is automatic (sweep-driven) only.
