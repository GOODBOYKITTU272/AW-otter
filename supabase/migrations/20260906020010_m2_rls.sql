-- Same pattern as M1's roles table: readable by any authenticated member of
-- the same organization (low-sensitivity structural metadata, needed for
-- dropdowns and display), mutable only by an org admin. No anon grants —
-- see 20260906020006_tighten_default_grants.sql for why that must be explicit.

alter table public.departments enable row level security;
grant select, insert, update on public.departments to authenticated;

create policy departments_select_own_org
  on public.departments
  for select
  to authenticated
  using (organization_id = private.current_organization_id());

create policy departments_insert_admin_org
  on public.departments
  for insert
  to authenticated
  with check (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy departments_update_admin_org
  on public.departments
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

alter table public.teams enable row level security;
grant select, insert, update on public.teams to authenticated;

create policy teams_select_own_org
  on public.teams
  for select
  to authenticated
  using (organization_id = private.current_organization_id());

create policy teams_insert_admin_org
  on public.teams
  for insert
  to authenticated
  with check (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy teams_update_admin_org
  on public.teams
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
