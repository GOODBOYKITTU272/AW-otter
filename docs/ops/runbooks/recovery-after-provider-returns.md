# Recovery after a provider returns (post-outage cleanup)

**Symptom**: you've just confirmed a provider outage (see "Provider
outage" runbook) has ended, and need to bring the affected queue back to
healthy without creating duplicate work or masking rows that need
different handling.

**Likely cause**: n/a — this is a post-recovery cleanup procedure, not a
new failure.

**Diagnostic**: get a full picture of what the outage left behind before
touching anything:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select queue, incident_type, count(*)
  from operational_incidents
  where resolved_at is null
  group by queue, incident_type
  order by 1, 2;
"
```

This separates three distinct populations that need different handling:
`stuck` (still claimed, never finished — safe to recover automatically),
`terminal_failure` with retries remaining vs. exhausted (only exhausted
ones need a manual decision), and anything already `retryable` (will
recover on its own via the normal processing route, needs no action).

**Safe remediation**:
1. Run the recovery sweep once to un-stick anything still sitting in an
   active/claimed state from during the outage:
   ```
   curl -s -X POST "$WEB_ORIGIN/api/internal/operations/recover" \
     -H "x-internal-queue-secret: $INTERNAL_QUEUE_SECRET"
   ```
2. For rows that terminal-failed (exhausted `MAX_RETRY_COUNT`) purely
   because of the outage (not a data problem), manually reset them to
   retryable state one queue at a time — do NOT do this for rows whose
   `error_code`/reason predates the outage window, only ones that failed
   during it.
3. Trigger each affected queue's normal processing route to drain the
   now-retryable backlog (see "Queue backlog" runbook for the exact
   routes).

**Verification**: re-run the grouped incident query above; counts should
drop to zero (or to only genuinely-unrelated pre-existing incidents)
within one or two processing cycles. Spot-check a handful of the
previously-failed rows reach a real terminal success state, and check
`/admin/operations` shows the queue back to Healthy.

**Escalation condition**: if resetting outage-affected rows to retryable
causes them to fail again immediately with the SAME error, the provider
hasn't actually recovered (or a different issue is masquerading as the
same outage) — stop resetting further rows and re-escalate as an ongoing
outage rather than continuing cleanup.
