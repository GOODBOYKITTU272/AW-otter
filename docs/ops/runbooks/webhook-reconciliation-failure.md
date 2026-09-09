# Webhook / reconciliation failure

**Symptom**: calendar events aren't showing up as new meetings, or
`calendar_event_jobs` isn't growing even though the connected calendar has
new events. This is upstream of the M16 stuck/failed job detection — a
webhook delivery failure or a reconciliation-loop error means jobs are
never even created, so `/admin/operations` may show nothing wrong (there's
nothing to be stuck) while the product is still broken.

**Likely cause**: either (a) Microsoft's webhook to
`/api/webhooks/microsoft/calendar` is failing/not arriving (subscription
expired, signature validation failing), or (b) one of the periodic
reconciliation routes (`/api/internal/tenant-sync/reconcile`,
`/api/internal/customer-linkage/reconcile`,
`/api/internal/scheduler-linkage/reconcile`) is erroring before it
completes its work.

**Diagnostic**:

Check whether calendar sync jobs are being created at all:

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select organization_id, count(*), max(created_at) as most_recent
  from calendar_event_jobs
  group by organization_id
  order by most_recent desc;
"
```

Check calendar connection health (webhook subscription state lives here):

```
docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "
  select c.id, m.organization_id, c.status, c.last_sync_at,
         c.last_reconciliation_result
  from calendar_connections c
  join organization_memberships m on m.id = c.organization_membership_id
  order by c.last_sync_at asc nulls first;
"
```

Manually invoke a reconciliation route and read its response directly
(these are synchronous and return their own result JSON, not just a
202 — errors surface immediately):

```
curl -s -X POST "$WEB_ORIGIN/api/internal/tenant-sync/reconcile" \
  -H "x-internal-queue-secret: $INTERNAL_QUEUE_SECRET" | jq .
```

**Safe remediation**: if a calendar connection's `status` or
`last_reconciliation_result` indicates an expired/revoked token, that
requires the tenant admin to reconnect via `/integrations` — this is not
something a recovery sweep can fix, since there's no stuck row, just a
broken upstream credential. If reconciliation itself is erroring (not a
per-connection auth issue), check the error detail from the manual `curl`
invocation above before taking any action — do not blindly re-run
reconciliation in a loop.

**Verification**: after a fix, re-run the manual reconciliation `curl`
call and confirm a clean JSON result with no `error` field; confirm new
`calendar_event_jobs` rows start appearing for the affected organization
within one sync cycle.

**Escalation condition**: if `calendar_connections.status` shows healthy
for an organization but no new `calendar_event_jobs` rows appear across
multiple manual reconciliation runs, escalate — this points at a logic
bug in the reconciliation path itself, not a credential or one-off
failure, and needs code-level investigation.
