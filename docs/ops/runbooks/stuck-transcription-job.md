# Stuck transcription job

**Symptom**: `/admin/operations` shows a "Transcription" item flagged
Stuck, or an open incident with `queue = transcription`,
`incident_type = stuck`.

**Likely cause**: a worker claimed a `meeting_transcripts` row (flipped it
to `processing_status = 'processing'`) and crashed, timed out, or lost its
connection before reaching its own catch block, so `retry_count`/
`next_retry_at` never advanced. The row has been sitting in `processing`
for 30+ minutes with no progress (`STUCK_THRESHOLD_MINUTES` in
`packages/domain/src/operations.ts`).

**Diagnostic**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select id, meeting_id, organization_id, processing_status, retry_count,
         error_code, updated_at, now() - updated_at as stuck_for
  from meeting_transcripts
  where processing_status = 'processing'
    and updated_at < now() - interval '30 minutes'
  order by updated_at asc;
"
```

**Safe remediation**: do not manually flip `processing_status` by hand —
that bypasses the CAS claim guard and risks a race with a worker that is
still (slowly) running. Instead call the recovery sweep, which only acts on
rows still matching their observed `processing_status`/`updated_at` at the
moment it runs:

```
curl -s -X POST "$WEB_ORIGIN/api/internal/operations/recover" \
  -H "x-internal-queue-secret: $INTERNAL_QUEUE_SECRET"
```

This reverts the row to `retryable` with a fresh `next_retry_at` (bounded
backoff) if it has attempts remaining, or to `failed` if `retry_count` has
reached `MAX_RETRY_COUNT` (5) — see "Repeated terminal failures" runbook
for the latter case.

**Verification**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select id, processing_status, retry_count, next_retry_at, error_code
  from meeting_transcripts where id = '<the id from the diagnostic query>';
"
```

Expect `processing_status` no longer `processing`, `error_code =
'worker_stuck_timeout'`, and either a future `next_retry_at` or (if
exhausted) `processing_status = 'failed'`. Then confirm the normal
transcription queue (`processTranscriptionQueue`, triggered via
`/api/internal/transcription/process`) picks the row back up on its next
run if it's `retryable`.

**Escalation condition**: if the same `meeting_id` recurs as stuck more
than twice in a day (check `occurrence_count` on its `operational_incidents`
row), or if the sweep itself errors, stop and escalate — this points at a
systemic issue (e.g. the transcription worker process itself is down or a
downstream provider is unreachable), not an isolated stuck row. See
"Provider outage" runbook.
