# M16 Operations Runbooks

Eight runbooks for the failure modes the M16 reliability slice covers. Each
follows: Symptom / Likely cause / Diagnostic / Safe remediation /
Verification / Escalation.

Conventions used throughout:

- **DB access**: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "<query>"` — the local Supabase Postgres container. In a real deployed environment, substitute the project's `psql` connection string (never run ad-hoc UPDATE/DELETE against production without a second person present and a transaction you can roll back).
- **Recovery sweep**: `POST /api/internal/operations/recover`, header `x-internal-queue-secret: $INTERNAL_QUEUE_SECRET`, run per organization internally — see `packages/domain/src/operations-recovery.ts`. Not yet on a schedule (scheduled/cron invocation is M17 scope); today it is triggered manually or by whatever process the on-call runs it from.
- **Visibility**: `/admin/operations` (organization-scoped, admin-only) shows live queue health (failed/stuck counts) and open incidents. Always check this first.
- **The four queues**: `calendar_event_jobs` (calendar sync), `meeting_transcripts` (transcription), `ai_runs` (meeting intelligence), `meeting_bot_jobs` (meeting bot). See `docs/product/m16-plan.md` §1 for the full per-queue inventory (active status, retry field, backoff formula).

None of these commands should ever need to read `raw_response`/transcript
text/CRM payload columns to diagnose a stuck or failed job — status,
timestamps, retry counts, and the short coded `error_code`/`last_error`
columns are enough. If a diagnosis seems to require reading customer
content, stop and escalate instead (see each runbook's escalation
condition).

## Acceptance and Real Evidence Safety Invariant

- **Real Meeting Evidence** (`039c787e-b11f-418b-8d3e-4b9bc107407f`):
  Strictly read-only. Acceptance testing must only READ recording, transcript, integrity flags, and meeting metadata via normal authenticated session routes. Test scripts and CI routines must NEVER run mutations (upload, upsert, delete, update, link customer, create AI run, create recap, or mutate recording metadata) against real evidence.
- **Dedicated Workflow Fixture** (`98000000-0000-0000-0000-00000000000a`):
  All workflow and mutation testing (Save Draft, Approve Recap, Manager view, forged mutations) MUST target this dedicated fixture or an isolated disposable Supabase stack.
