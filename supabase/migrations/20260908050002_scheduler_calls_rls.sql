-- scheduler_calls RLS. Same revoke-all-then-grant-back convention as every
-- other table in this schema. This is a pure ingestion table — only the
-- server-side sync (service_role) ever writes it; no authenticated INSERT/
-- UPDATE/DELETE policy exists at all, same shape as meeting_external_events
-- (20260906020021) having zero authenticated policies. AMs interact with
-- the RESULT of a sync (meetings.customer_id/call_type) through the
-- existing M7A routes, never with scheduler_calls directly.

revoke all on public.scheduler_calls from anon, authenticated, service_role;

alter table public.scheduler_calls enable row level security;
grant select on public.scheduler_calls to authenticated;
grant select, insert, update on public.scheduler_calls to service_role;

-- Visible to the call's current owner, or org-wide to an Admin — same
-- shape as customers_select_own / customers_select_admin_org. Deliberately
-- based on THIS row's own owner_membership_id (the call's current AM),
-- not a join through customers (whose owner may lag behind mid-sync).
create policy scheduler_calls_select_own
  on public.scheduler_calls
  for select
  to authenticated
  using (owner_membership_id = private.current_membership_id());

create policy scheduler_calls_select_admin_org
  on public.scheduler_calls
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );
