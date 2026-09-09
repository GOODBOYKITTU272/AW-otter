# Provider outage (OpenRouter / Vexa / Microsoft Graph)

**Symptom**: a burst of `terminal_failure` incidents across one queue in a
short window, or `/admin/operations` showing failed counts climbing for
one specific queue while others stay healthy — this codebase calls out to
OpenRouter (transcription normalization, meeting intelligence, Ask Signal),
Vexa (meeting bots), and Microsoft Graph (calendar sync). A real outage in
one of these shows up as many DIFFERENT jobs failing the same way, not one
row misbehaving.

**Likely cause**: the external provider is down, rate-limiting, or
rejecting requests (expired credentials, quota exhausted). Distinguish
provider-side from a genuine code bug by checking whether failures are
concentrated in ONE queue (provider-shaped) vs. scattered across unrelated
queues (more likely a local bug or DB issue).

**Diagnostic**:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select queue, incident_type, count(*), max(last_seen_at) as most_recent
  from operational_incidents
  where resolved_at is null
    and last_seen_at > now() - interval '1 hour'
  group by queue, incident_type
  order by count(*) desc;
"
```

For the affected queue's own error detail, e.g. transcription:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select error_code, safe_error_metadata->>'message' as message, count(*)
  from meeting_transcripts
  where processing_status = 'failed' and updated_at > now() - interval '1 hour'
  group by 1, 2 order by count(*) desc;
"
```
(Substitute `ai_runs`/`status` for meeting intelligence, or check
`meeting_bot_jobs`/`last_error` for bots.)

**Safe remediation**: do NOT run the recovery sweep repeatedly hoping it
helps — if the provider itself is down, recovered jobs will just fail
again on their next attempt and burn through `MAX_RETRY_COUNT` faster.
1. Confirm the provider's own status page / your account dashboard.
2. If it's a credentials issue (e.g. an expired `OPENROUTER_API_KEY`),
   rotate the credential in the deployment's environment config — this is
   the ONLY case where you fix root cause before recovering rows.
3. Once the provider is confirmed healthy again, run the recovery sweep
   once to un-stick anything still sitting in an active state, then let
   the normal queue-processing routes drain the `retryable` backlog.

**Verification**: re-run the diagnostic grouped-incident query above;
`most_recent` should stop advancing for the affected queue, and
`/admin/operations`'s failed count for that queue should stop climbing.
Spot-check one previously-failed row transitions to `completed` on its
next natural retry.

**Escalation condition**: if incidents are climbing across MULTIPLE
unrelated queues simultaneously (e.g. transcription AND meeting
intelligence AND calendar sync all failing at once), this is more likely a
shared-infrastructure issue (DB connectivity, network egress) than a
single provider outage — escalate immediately rather than working each
queue individually.
