-- M11: AM Workspace + Meeting Recap. The only migration M11 needs — a
-- single additive SELECT policy, no new tables/columns.
--
-- Codex Pass 1 plan review (BLOCKING, fixed): scheduler_calls previously had
-- only scheduler_calls_select_own (owner equality) and
-- scheduler_calls_select_admin_org (20260908050002) — no manager-scope
-- policy existed anywhere, unlike customers/call_records/customer_truth_facts
-- which all got one in M10. M11's customer journey timeline (previous/
-- current/next call, drawn from scheduler_calls) needs a manager to see
-- their reports' customers' calls the same way they already see those
-- customers' truth facts and call records. Exact same shape as
-- call_records_select_manager_scope (20260909080001) — reuses
-- private.has_permission('intelligence.read') / private.is_manager_of()
-- directly, no new helper function.
create policy scheduler_calls_select_manager_scope
  on public.scheduler_calls
  for select
  to authenticated
  using (
    private.has_permission('intelligence.read')
    and organization_id = private.current_organization_id()
    and private.is_manager_of(private.current_membership_id(), owner_membership_id)
  );
