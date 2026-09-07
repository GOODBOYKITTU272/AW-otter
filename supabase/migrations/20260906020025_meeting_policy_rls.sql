-- M5 RLS. Depends on private.is_manager_of(uuid, uuid) from
-- 20260906020024_is_manager_of.sql (Codex, isolated worktree, reviewed
-- before merge). Revoke-then-grant on every new table, same lesson this
-- project has needed since M1.

-- meeting_policy_sets / meeting_policy_rules: read = any authenticated
-- member of the org (matches the blueprint's "Effective policy" row —
-- every role, including AM, can see what policy governs their meetings),
-- write = policy.manage only (admin, per the M1 seed).
revoke all on public.meeting_policy_sets from anon, authenticated, service_role;
alter table public.meeting_policy_sets enable row level security;
grant select, update on public.meeting_policy_sets to authenticated;
grant select on public.meeting_policy_sets to service_role;

create policy meeting_policy_sets_select_own_org
  on public.meeting_policy_sets
  for select
  to authenticated
  using (organization_id = private.current_organization_id());

create policy meeting_policy_sets_manage
  on public.meeting_policy_sets
  for all
  to authenticated
  using (
    private.has_permission('policy.manage')
    and organization_id = private.current_organization_id()
  )
  with check (
    private.has_permission('policy.manage')
    and organization_id = private.current_organization_id()
  );

revoke all on public.meeting_policy_rules from anon, authenticated, service_role;
alter table public.meeting_policy_rules enable row level security;
grant select, update on public.meeting_policy_rules to authenticated;
grant select on public.meeting_policy_rules to service_role;

create policy meeting_policy_rules_select_own_org
  on public.meeting_policy_rules
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meeting_policy_sets ps
      where ps.id = meeting_policy_rules.policy_set_id
        and ps.organization_id = private.current_organization_id()
    )
  );

create policy meeting_policy_rules_manage
  on public.meeting_policy_rules
  for all
  to authenticated
  using (
    private.has_permission('policy.manage')
    and exists (
      select 1 from public.meeting_policy_sets ps
      where ps.id = meeting_policy_rules.policy_set_id
        and ps.organization_id = private.current_organization_id()
    )
  )
  with check (
    private.has_permission('policy.manage')
    and exists (
      select 1 from public.meeting_policy_sets ps
      where ps.id = meeting_policy_rules.policy_set_id
        and ps.organization_id = private.current_organization_id()
    )
  );

-- meeting_policy_decisions: the detailed per-evaluation audit trail —
-- admin-only read (the AM-facing signal is meetings.eligibility_status,
-- already visible via existing meetings RLS). service_role writes it
-- (the evaluator always runs server-side).
revoke all on public.meeting_policy_decisions from anon, authenticated, service_role;
alter table public.meeting_policy_decisions enable row level security;
grant select on public.meeting_policy_decisions to authenticated;
grant select, insert on public.meeting_policy_decisions to service_role;

create policy meeting_policy_decisions_select_admin_org
  on public.meeting_policy_decisions
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- recording_exemption_requests: the actual do-not-record workflow.
-- Insert: an AM (or anyone) may request ONLY for a meeting they own,
-- and only as themselves (requested_by must be the caller). Select:
-- your own requests, or admin org-wide, or a manager/senior_manager with
-- exceptions.approve whose reporting tree (private.is_manager_of)
-- includes the meeting's owner. Update (approve/reject): same
-- admin-or-manager-scope as select, minus the requester's own-request
-- branch — an AM can never update a request's status, only read it, and
-- must never approve/reject their own.
revoke all on public.recording_exemption_requests from anon, authenticated, service_role;
alter table public.recording_exemption_requests enable row level security;
grant select, insert, update on public.recording_exemption_requests to authenticated;
grant select, insert, update on public.recording_exemption_requests to service_role;

create policy recording_exemption_requests_insert_own
  on public.recording_exemption_requests
  for insert
  to authenticated
  with check (
    status = 'requested'
    and requested_by = private.current_membership_id()
    and organization_id = private.current_organization_id()
    and exists (
      select 1 from public.meetings m
      where m.id = recording_exemption_requests.meeting_id
        and m.owner_membership_id = private.current_membership_id()
        and m.organization_id = recording_exemption_requests.organization_id
    )
  );

create policy recording_exemption_requests_select
  on public.recording_exemption_requests
  for select
  to authenticated
  using (
    requested_by = private.current_membership_id()
    or (
      private.is_org_admin()
      and organization_id = private.current_organization_id()
    )
    or (
      private.has_permission('exceptions.approve')
      and organization_id = private.current_organization_id()
      and exists (
        select 1 from public.meetings m
        where m.id = recording_exemption_requests.meeting_id
          and m.owner_membership_id is not null
          and private.is_manager_of(private.current_membership_id(), m.owner_membership_id)
      )
    )
  );

create policy recording_exemption_requests_update_review
  on public.recording_exemption_requests
  for update
  to authenticated
  using (
    (
      private.is_org_admin()
      and organization_id = private.current_organization_id()
    )
    or (
      private.has_permission('exceptions.approve')
      and organization_id = private.current_organization_id()
      and exists (
        select 1 from public.meetings m
        where m.id = recording_exemption_requests.meeting_id
          and m.owner_membership_id is not null
          and private.is_manager_of(private.current_membership_id(), m.owner_membership_id)
      )
    )
  )
  with check (
    reviewed_by = private.current_membership_id()
    and (
      (
        private.is_org_admin()
        and organization_id = private.current_organization_id()
      )
      or (
        private.has_permission('exceptions.approve')
        and organization_id = private.current_organization_id()
        and exists (
          select 1 from public.meetings m
          where m.id = recording_exemption_requests.meeting_id
            and m.owner_membership_id is not null
            and private.is_manager_of(private.current_membership_id(), m.owner_membership_id)
        )
      )
    )
  );
