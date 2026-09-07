-- Real bug found via genuine local end-to-end testing (not a mock): the
-- recording_exemption_requests RLS policies (20260906020025) check
-- private.is_manager_of() inside an EXISTS subquery against `meetings` —
-- but that subquery is itself subject to meetings' own RLS. M4 explicitly
-- deferred manager/senior_manager visibility into their reports' meetings
-- ("Manager/senior_manager direct-report visibility is DEFERRED... no
-- clean recursive-reporting-line RLS helper exists yet, out of M4's
-- scope" — 20260906020018). M5 built that helper (private.is_manager_of),
-- and a manager cannot review an exception request for a meeting they
-- have no RLS visibility into at all — the EXISTS check silently returns
-- false regardless of the reporting relationship, no matter how correct
-- is_manager_of itself is. This is the "genuine blocker" that justifies
-- touching meetings RLS from M5, per the explicit instruction to leave M4
-- alone otherwise. A new migration, not an edit to any M4 file.
--
-- Deliberately narrow: gated behind exceptions.approve, not a general
-- "managers can browse all reports' meetings" grant — this exists to
-- support the exception-review capability specifically, nothing broader
-- was asked for.
create policy meetings_select_manager_scope
  on public.meetings
  for select
  to authenticated
  using (
    private.has_permission('exceptions.approve')
    and organization_id = private.current_organization_id()
    and owner_membership_id is not null
    and private.is_manager_of(private.current_membership_id(), owner_membership_id)
  );
