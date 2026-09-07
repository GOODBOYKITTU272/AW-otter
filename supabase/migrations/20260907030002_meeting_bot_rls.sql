-- M6 RLS. Deliberately reuses the nested-RLS behavior M5 diagnosed and
-- fixed (20260906020027's own comment): an EXISTS subquery against
-- `meetings` is itself subject to meetings' own RLS for the querying
-- role. Rather than re-deriving owner/admin/manager-scope logic here,
-- meeting_bot_jobs visibility is defined as exactly "can you see the
-- meeting" — AM (own meeting), admin (org-wide), manager-in-tree
-- (exceptions.approve + is_manager_of, via meetings_select_manager_scope)
-- all fall out of that for free, and stay correct if meetings' own
-- visibility rules ever change.
revoke all on public.meeting_bot_jobs from anon, authenticated, service_role;
alter table public.meeting_bot_jobs enable row level security;
grant select on public.meeting_bot_jobs to authenticated;
grant select, insert, update on public.meeting_bot_jobs to service_role;

create policy meeting_bot_jobs_select_meeting_visible
  on public.meeting_bot_jobs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_bot_jobs.meeting_id
    )
  );

-- No authenticated insert/update/delete policy at all: bot scheduling,
-- provider calls and status transitions are exclusively worker/service-
-- role driven (matches meeting_policy_decisions — the evaluator always
-- runs server-side, never a direct client write).

-- meeting_lifecycle_events: admin-only, org-scoped technical log (see the
-- table's own comment for why this is narrower than meeting_bot_jobs).
revoke all on public.meeting_lifecycle_events from anon, authenticated, service_role;
alter table public.meeting_lifecycle_events enable row level security;
grant select on public.meeting_lifecycle_events to authenticated;
grant select, insert on public.meeting_lifecycle_events to service_role;

create policy meeting_lifecycle_events_select_admin_org
  on public.meeting_lifecycle_events
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );
