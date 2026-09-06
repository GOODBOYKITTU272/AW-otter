-- calendar_connections: a person manages their own connection (connect,
-- reconnect, disconnect all go through the connecting user's own
-- authenticated session — never "membership_id in the request body"). Admin
-- gets read-only visibility into their own organization's connections, not
-- write access to someone else's.
alter table public.calendar_connections enable row level security;
grant select, insert, update on public.calendar_connections to authenticated;

create policy calendar_connections_select_own
  on public.calendar_connections
  for select
  to authenticated
  using (organization_membership_id = private.current_membership_id());

create policy calendar_connections_select_admin_org
  on public.calendar_connections
  for select
  to authenticated
  using (
    private.is_org_admin()
    and exists (
      select 1
      from public.organization_memberships m
      where m.id = calendar_connections.organization_membership_id
        and m.organization_id = private.current_organization_id()
    )
  );

create policy calendar_connections_insert_own
  on public.calendar_connections
  for insert
  to authenticated
  with check (organization_membership_id = private.current_membership_id());

create policy calendar_connections_update_own
  on public.calendar_connections
  for update
  to authenticated
  using (organization_membership_id = private.current_membership_id())
  with check (organization_membership_id = private.current_membership_id());

-- calendar_connection_secrets: intentionally no policies and no grants at
-- all (not even a read-only one) — see the table comment in
-- 20260906020012_microsoft_integration_tables.sql. This table stays fully
-- unreachable through the client-facing API regardless of RLS, and RLS is
-- still enabled as defense in depth.
alter table public.calendar_connection_secrets enable row level security;

-- provider_subscriptions / calendar_sync_cursors: visible and writable
-- exactly where the underlying calendar_connection is (self, or admin
-- read-only within their org). Neither table is ever written directly by
-- end users through the UI — the connect flow creates them using the
-- connecting user's own session, which is why "insert/update" still means
-- "owns the underlying connection", not "is an admin".
alter table public.provider_subscriptions enable row level security;
grant select, insert, update on public.provider_subscriptions to authenticated;

create policy provider_subscriptions_select_visible
  on public.provider_subscriptions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.calendar_connections c
      where c.id = provider_subscriptions.calendar_connection_id
        and (
          c.organization_membership_id = private.current_membership_id()
          or (
            private.is_org_admin()
            and exists (
              select 1
              from public.organization_memberships m
              where m.id = c.organization_membership_id
                and m.organization_id = private.current_organization_id()
            )
          )
        )
    )
  );

create policy provider_subscriptions_write_own
  on public.provider_subscriptions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.calendar_connections c
      where c.id = provider_subscriptions.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  );

create policy provider_subscriptions_update_own
  on public.provider_subscriptions
  for update
  to authenticated
  using (
    exists (
      select 1 from public.calendar_connections c
      where c.id = provider_subscriptions.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  )
  with check (
    exists (
      select 1 from public.calendar_connections c
      where c.id = provider_subscriptions.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  );

alter table public.calendar_sync_cursors enable row level security;
grant select, insert, update on public.calendar_sync_cursors to authenticated;

create policy calendar_sync_cursors_select_visible
  on public.calendar_sync_cursors
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.calendar_connections c
      where c.id = calendar_sync_cursors.calendar_connection_id
        and (
          c.organization_membership_id = private.current_membership_id()
          or (
            private.is_org_admin()
            and exists (
              select 1
              from public.organization_memberships m
              where m.id = c.organization_membership_id
                and m.organization_id = private.current_organization_id()
            )
          )
        )
    )
  );

create policy calendar_sync_cursors_write_own
  on public.calendar_sync_cursors
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.calendar_connections c
      where c.id = calendar_sync_cursors.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  );

create policy calendar_sync_cursors_update_own
  on public.calendar_sync_cursors
  for update
  to authenticated
  using (
    exists (
      select 1 from public.calendar_connections c
      where c.id = calendar_sync_cursors.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  )
  with check (
    exists (
      select 1 from public.calendar_connections c
      where c.id = calendar_sync_cursors.calendar_connection_id
        and c.organization_membership_id = private.current_membership_id()
    )
  );

-- Lets application code (not just the M2 membership-change trigger) record
-- audit events for the user's own organization — needed for Microsoft
-- connection/subscription/sync events, which aren't simple column diffs on
-- one row the way membership changes are. M2 only granted SELECT on
-- audit_events to authenticated; INSERT needs its own grant too — a policy
-- alone does nothing without the underlying table-level privilege.
grant insert on public.audit_events to authenticated;

create policy audit_events_insert_own_org
  on public.audit_events
  for insert
  to authenticated
  with check (organization_id = private.current_organization_id());
