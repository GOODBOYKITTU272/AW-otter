# Verify no duplicate side effects occurred

**Symptom**: after any recovery action (a sweep run, a manual re-queue, a
retry after a provider outage), you need to confirm the recovered job
didn't produce duplicate downstream data — duplicate transcript segments,
duplicate AI/customer-truth writes, or a second meeting bot actually
joining a call that already has one.

**Likely cause**: n/a — this is a verification procedure, not a failure
mode. It exists because "did recovery actually happen safely" is not the
same question as "did the row's status change," and the M16 requirement is
specifically that recovery must never duplicate side effects.

**Diagnostic** — per queue, the idempotency guarantee to check:

- **Transcription** (`meeting_transcripts` → `transcript_segments`): a
  retried transcription job must not create a second set of segments for
  the same transcript. Check for duplicates directly:
  ```
  docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
    select transcript_id, start_ms, end_ms, count(*)
    from transcript_segments
    group by transcript_id, start_ms, end_ms
    having count(*) > 1;
  "
  ```
  Zero rows returned is correct. (Covered at the unit level by
  `transcription.test.ts`'s "does not create duplicate segments when
  reprocessed after a partial prior attempt" test.)

- **Meeting intelligence** (`ai_runs` → customer truth writes): a retried
  run must not double-apply `customer_truth_materialized_at` writes or
  create duplicate `customer_truth_facts` proposals for the same meeting.
  ```
  docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
    select source_meeting_id, field_key, count(*)
    from customer_truth_facts
    where source_meeting_id = '<meeting id>'
    group by source_meeting_id, field_key
    having count(*) > 1;
  "
  ```

- **Meeting bot** (`meeting_bot_jobs`): a recovered "stuck while joining"
  job must not result in two bots actually in the same call. Check the
  provider session, not just the DB row:
  ```
  docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
    select meeting_id, count(*) filter (where status in ('joining','joined'))
    from meeting_bot_jobs
    group by meeting_id
    having count(*) filter (where status in ('joining','joined')) > 1;
  "
  ```
  Zero rows expected — `syncMeetingBotIntent`'s own job-creation query
  already guards against a second live job per meeting; this check
  confirms recovery didn't reintroduce a second one.

- **Calendar sync** (`calendar_event_jobs`): the table's own
  `calendar_event_jobs_pending_dedupe_uq` partial unique index
  (`calendar_connection_id, external_event_id, change_type` where status
  in `pending`/`processing`) makes a true duplicate impossible at the DB
  level — a query returning zero rows here would indicate the index itself
  was dropped, which is a bigger problem than duplicate recovery:
  ```
  docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
    \d calendar_event_jobs
  " | grep pending_dedupe_uq
  ```

**Safe remediation**: if duplicates ARE found, do not delete rows blindly
— identify which one is the "real" one (earliest `created_at` for
transcript segments/facts; the bot job that actually has an active
provider session for bot jobs) and escalate rather than guessing which to
remove, since removing the wrong one can lose real data.

**Verification**: all four diagnostic queries above return zero rows.

**Escalation condition**: any nonzero result from the diagnostic queries
above is itself the escalation trigger — this is a real idempotency
violation, not a transient state, and should not be worked around locally.
