# Repeated terminal failures

**Symptom**: an open incident with `incident_type = terminal_failure` and
`occurrence_count` growing, or `/admin/operations` showing a persistently
nonzero failed count for one queue across repeated checks (not a one-time
blip that resolves itself).

**Likely cause**: a job type has hit `MAX_RETRY_COUNT` (5) and given up —
either a genuinely permanent failure (bad input data, a resource that no
longer exists upstream) or a retryable-looking failure that isn't actually
transient (see the disclosed gap below).

**Diagnostic**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select queue, entity_id, occurrence_count, first_seen_at, last_seen_at, reason
  from operational_incidents
  where resolved_at is null and incident_type = 'terminal_failure'
  order by occurrence_count desc, last_seen_at desc
  limit 20;
"
```

Then pull the actual row for detail, e.g. for meeting intelligence:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select id, meeting_id, status, retry_count, error_code,
         safe_error_metadata->>'message' as message
  from ai_runs where id = '<entity_id from above>';
"
```

**Safe remediation**: do not simply re-run the recovery sweep — a
terminal-failed row (`status = 'failed'` / `processing_status = 'failed'`
/ `dead_letter`) is intentionally NOT touched by `recoverStuckJobs` (it
only acts on rows still in an active/claimed state), so re-running the
sweep will correctly do nothing here. Read the actual failure reason
first:
- If it's a genuinely bad/malformed input (e.g. a meeting with no
  recording), no automated remediation is safe — this needs product-level
  handling, not a queue retry.
- If it's a provider error that should have been classified as
  non-retryable but wasn't — this is a known, disclosed gap: `ai_runs`'
  `classifyError` (in `meeting-intelligence.ts`) maps every
  `IntelligenceApiError`, including a real HTTP 401, to the same generic
  `intelligence_failed` code and retries it blindly. A bad API key will
  burn all 5 retries and terminal-fail every affected run. Fix the
  credential (see "Provider outage" runbook), then manually re-queue by
  resetting `status` to `pending`/`retryable` — do this by hand only after
  confirming the root cause, and only for rows genuinely affected by that
  root cause, not as a blanket reset.

**Verification**: after addressing root cause and any manual re-queue,
confirm the row transitions past `running`/`processing` to a real terminal
success on its next natural attempt, and that
`operational_incidents.resolved_at` gets set for that row (the next
recovery sweep's `syncIncidentsWithCurrentState` call resolves it
automatically once the row is no longer failed).

**Escalation condition**: if `occurrence_count` keeps climbing after a
believed fix (i.e. the row keeps re-entering a failed terminal state), or
if failures span many different `entity_id`s with the same `reason`,
escalate — this is a systemic classification or provider issue, not
something to keep manually re-queuing one row at a time.
