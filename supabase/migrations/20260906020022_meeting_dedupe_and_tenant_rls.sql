-- meeting_external_events: writes stay service_role only (only
-- upsertCanonicalMeeting/cancelCanonicalMeeting touch it). Reads get the
-- same admin-scoped exception as calendar_event_jobs got in
-- 20260906020019 — /admin/meetings needs it to compute per-meeting sync
-- state across every mailbox that's observed a canonical meeting.
-- Revoke-then-grant, same lesson learned every table in this project has
-- needed since M1.
revoke all on public.meeting_external_events from anon, authenticated, service_role;
alter table public.meeting_external_events enable row level security;
grant select on public.meeting_external_events to authenticated;
-- delete is needed: cancelCanonicalMeeting removes a stale observer's
-- mapping row once acted on (so a future notification for the same
-- mailbox+event id is treated as fresh rather than resolving to a meeting
-- that mailbox no longer has).
grant select, insert, update, delete on public.meeting_external_events to service_role;

-- Direct column check now that organization_id lives on the row itself
-- (Finding #2 fix) — matches calendar_event_jobs_select_admin_org's shape,
-- simpler and cheaper than the meetings join this policy used before.
create policy meeting_external_events_select_admin_org
  on public.meeting_external_events
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- microsoft_tenant_connections: admin-managed, no "select own" policy
-- exists because nothing about it is owned by an individual employee —
-- it's an organization-wide switch. Codex's review: enabling this is a
-- bigger blast radius than one person connecting their own account (it
-- reads every eligible employee's calendar without individual consent),
-- so it stays strictly is_org_admin()-gated with no broader authenticated
-- visibility at all (unlike calendar_connections, where every employee can
-- at least see connection status).
revoke all on public.microsoft_tenant_connections from anon, authenticated, service_role;
alter table public.microsoft_tenant_connections enable row level security;
grant select, insert, update on public.microsoft_tenant_connections to authenticated;
-- service_role reads this to find orgs with tenant sync enabled, and
-- writes back last_reconciliation_result after each run (the one thing it
-- does own — same as calendar_connections.last_reconciliation_result).
-- Enabling/disabling itself always goes through the admin's own
-- authenticated session, same as calendar_connections' connect/disconnect
-- pattern — service_role never changes `status`.
grant select, update on public.microsoft_tenant_connections to service_role;

create policy microsoft_tenant_connections_admin_select
  on public.microsoft_tenant_connections
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy microsoft_tenant_connections_admin_insert
  on public.microsoft_tenant_connections
  for insert
  to authenticated
  with check (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy microsoft_tenant_connections_admin_update
  on public.microsoft_tenant_connections
  for update
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  )
  with check (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );
