-- Real bug found by Codex's M5 final independent review: the manager
-- exceptions queue (apps/web/app/manager/exceptions/page.tsx) resolves
-- requester/reviewer display names by querying organization_memberships —
-- but M2's RLS (20260906020005_row_level_security.sql) only ever let a
-- non-admin see their OWN membership row (memberships_select_self). A
-- manager reviewing their own report's request would see every name as
-- "Unknown". This is exactly the "Manager/senior_manager direct-report
-- visibility is DEFERRED... no clean recursive-reporting-line RLS helper
-- exists yet" gap M4 explicitly named as out of its own scope — M5 built
-- that helper (private.is_manager_of) and now has a real, concrete UI
-- need for it, so this is the genuine blocker that justifies a new
-- migration touching membership RLS from M5 (M2's own files are
-- untouched). Mirrors meetings_select_manager_scope
-- (20260906020027) exactly: narrow, gated behind exceptions.approve, not
-- a general "managers can browse the org directory" grant.
create policy memberships_select_manager_scope
  on public.organization_memberships
  for select
  to authenticated
  using (
    private.has_permission('exceptions.approve')
    and organization_id = private.current_organization_id()
    and private.is_manager_of(private.current_membership_id(), id)
  );
