# Queue backlog

**Symptom**: a queue's pending count is growing over time without
draining — not "stuck" (rows aren't claimed and going stale) and not
"failed" (rows aren't erroring), just accumulating faster than the
processing routes clear them. Note: `/admin/operations` deliberately does
NOT count `pending`/queued-but-unclaimed rows as stuck (see
`packages/domain/src/operations.ts` — this was a real false-positive bug
caught before M16's first slice shipped), so a pure backlog will NOT show
up as a stuck or failed count there. Check pending counts directly.

**Likely cause**: either (a) the queue's own processing route isn't being
invoked often enough (no scheduler wired up yet — this repo does not yet
have a cron/scheduled invocation of the `/api/internal/*` process routes;
that is explicit M17 scope, not M16), or (b) genuine throughput — more
work is arriving than the batch size per invocation can clear.

**Diagnostic**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select 'calendar_event_jobs' as queue, status, count(*) from calendar_event_jobs group by status
  union all
  select 'meeting_transcripts', processing_status, count(*) from meeting_transcripts group by processing_status
  union all
  select 'ai_runs', status, count(*) from ai_runs group by status
  union all
  select 'meeting_bot_jobs', status, count(*) from meeting_bot_jobs group by status
  order by 1, 3 desc;
"
```

Look specifically at the pending/queued state per queue (`pending` for
calendar/transcription/ai_runs, `scheduled` for bots) and how it trends
over repeated checks a few minutes apart.

**Safe remediation**: manually invoke the relevant processing route to
drain a backlog immediately:

```
curl -s -X POST "$WEB_ORIGIN/api/internal/transcription/process" \
  -H "x-internal-queue-secret: $INTERNAL_QUEUE_SECRET" | jq .
```

(substitute `/api/internal/calendar-events/process`,
`/api/internal/meeting-intelligence/process`, or
`/api/internal/meeting-bots/tick` as appropriate). If this needs to be
done repeatedly to keep up, that's the real signal this queue needs a
recurring scheduled invocation — flag for M17 rather than treating it as
an incident to firefight indefinitely.

**Verification**: re-run the diagnostic query; the pending count for the
affected queue should drop after each manual invocation and its
`completed`/similar terminal-success count should rise by a comparable
amount.

**Escalation condition**: if manually draining the queue doesn't reduce
the pending count (i.e. the processing route runs successfully but pending
stays flat or grows), that points at a claim-query bug, not a throughput
problem — escalate for code-level investigation rather than continuing to
re-run the route.
