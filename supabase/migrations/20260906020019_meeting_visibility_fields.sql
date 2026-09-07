-- Additive fields needed for the M4 /admin/meetings progress screen to
-- show real, non-fabricated state. All three were signals we were already
-- receiving from Graph (organizer, isOnlineMeeting/onlineMeetingProvider,
-- a changed scheduled_start/end) but discarding.
alter table public.meetings
  add column organizer_name text,
  add column organizer_email extensions.citext;

-- Reconciliation (packages/domain/src/meetings.ts reconcileCalendarConnection)
-- already computes a result; it was never persisted anywhere. One row per
-- connection, overwritten each run — a history table is out of scope here.
alter table public.calendar_connections
  add column last_reconciliation_result jsonb;

-- calendar_event_jobs previously had zero grants/policies for
-- anon/authenticated at all (deliberate — see 20260906020018's comment).
-- The admin-visible queue view in /admin/meetings needs real read access,
-- so this is a genuine, reviewed loosening: admin, read-only, own org only
-- — exactly the same shape as meetings_select_admin_org and
-- calendar_connections_select_admin_org. Still nothing for anon, still no
-- write access, still no visibility for non-admin authenticated users.
grant select on public.calendar_event_jobs to authenticated;

-- Reviewed by Codex: authorizing off calendar_event_jobs.organization_id
-- directly would trust a column documented as debugging/filtering
-- metadata, not an authorization source, with no DB constraint tying it to
-- the connection it's actually enqueued against. Deriving org from the
-- real ownership chain (connection -> membership -> organization), same
-- as calendar_connections_select_admin_org, means a drifted/wrong
-- organization_id on the job row can't leak it into the wrong org's view.
create policy calendar_event_jobs_select_admin_org
  on public.calendar_event_jobs
  for select
  to authenticated
  using (
    private.is_org_admin()
    and exists (
      select 1
      from public.calendar_connections c
      join public.organization_memberships m on m.id = c.organization_membership_id
      where c.id = calendar_event_jobs.calendar_connection_id
        and m.organization_id = private.current_organization_id()
    )
  );
