# Stuck meeting-intelligence run

**Symptom**: `/admin/operations` shows "Meeting intelligence" flagged
Stuck, or an open incident with `queue = meeting_intelligence`,
`incident_type = stuck`.

**Likely cause**: an `ai_runs` row was claimed (`status = 'running'`) and
the worker never finished — a crash, timeout, or an unhandled exception
between the claim and the catch block in `meeting-intelligence.ts`. Sitting
in `running` for 30+ minutes with no update.

**Diagnostic**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select id, meeting_id, organization_id, status, retry_count, run_type,
         model, updated_at, now() - updated_at as stuck_for
  from ai_runs
  where status = 'running'
    and updated_at < now() - interval '30 minutes'
  order by updated_at asc;
"
```

**Safe remediation**: same principle as transcription — never hand-edit
`status`. Run the recovery sweep:

```
curl -s -X POST "$WEB_ORIGIN/api/internal/operations/recover" \
  -H "x-internal-queue-secret: $INTERNAL_QUEUE_SECRET"
```

The CAS update only lands if the row's `status`/`updated_at` still match
what the sweep observed, so it is safe to run repeatedly and safe to run
while a genuinely-still-working process holds the row (in that case the
sweep's update loses the race and does nothing — see "Verify no duplicate
side effects" runbook for why that's the correct, not just convenient,
behavior).

**Verification**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select id, status, retry_count, next_retry_at, error_code
  from ai_runs where id = '<the id from the diagnostic query>';
"
```

Expect `status = 'retryable'` (with `next_retry_at` set) or `status =
'failed'` if `retry_count` reached `MAX_RETRY_COUNT`. Confirm
`/api/internal/meeting-intelligence/process` picks the row back up on its
next run if retryable.

**Escalation condition**: `meeting-intelligence.ts`'s `classifyError` maps
every `IntelligenceApiError` (including a real HTTP 401 for a bad/expired
API key) to the same generic `intelligence_failed` code and retries it up
to `MAX_RETRY_COUNT` regardless — a genuinely bad API key will exhaust
retries and terminal-fail every run rather than fail fast. If several
`ai_runs` rows terminal-fail in a short window, check provider credentials
first (see "Provider outage" runbook) before assuming this is an
isolated-row issue.
