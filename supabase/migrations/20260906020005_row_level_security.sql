-- `private` is not in api.schemas (see supabase/config.toml), so nothing in
-- it is ever reachable as a PostgREST RPC endpoint regardless of grants —
-- these helpers exist only to be called from inside RLS policies below and
-- from trusted server-side code.
create schema if not exists private;

-- Every helper is SECURITY DEFINER with a fixed search_path: it must read
-- organization_memberships (and joins off it) to resolve the caller's own
-- identity, but organization_memberships itself carries RLS policies that
-- call these same helpers. Running as the function owner (a superuser role,
-- which bypasses RLS) breaks that recursion; the fixed search_path blocks
-- search_path hijacking, the standard risk with SECURITY DEFINER.

create or replace function private.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid();
$$;

create or replace function private.current_membership_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.organization_memberships
  where user_id = auth.uid()
    and status = 'active'
  limit 1;
$$;

create or replace function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_memberships
  where user_id = auth.uid()
    and status = 'active'
  limit 1;
$$;

create or replace function private.current_role_key()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select r.key
  from public.organization_memberships m
  join public.roles r on r.id = m.role_id
  where m.user_id = auth.uid()
    and m.status = 'active'
  limit 1;
$$;

create or replace function private.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(private.current_role_key() = 'admin', false);
$$;

create or replace function private.has_permission(p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.user_id = auth.uid()
      and m.status = 'active'
      and rp.permission_key = p_permission_key
  );
$$;

grant usage on schema private to authenticated;
grant execute on function private.current_profile_id() to authenticated;
grant execute on function private.current_membership_id() to authenticated;
grant execute on function private.current_organization_id() to authenticated;
grant execute on function private.current_role_key() to authenticated;
grant execute on function private.is_org_admin() to authenticated;
grant execute on function private.has_permission(text) to authenticated;

-- No grants at all to `anon` in this migration: unauthenticated access to
-- every table below is denied by the absence of a grant, before RLS is even
-- evaluated.
grant usage on schema public to authenticated;

-- organizations: read your own organization only.
alter table public.organizations enable row level security;
grant select on public.organizations to authenticated;

create policy organizations_select_own
  on public.organizations
  for select
  to authenticated
  using (id = private.current_organization_id());

-- profiles: read your own profile only. Admins get member visibility via
-- organization_memberships (which already carries display_name/work_email),
-- so there is no need for profiles to expose other users' rows in M1.
alter table public.profiles enable row level security;
grant select on public.profiles to authenticated;

create policy profiles_select_self
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- organization_memberships: read your own row, or every row in your own
-- organization if you're an admin. Mutations are admin-only and org-scoped.
alter table public.organization_memberships enable row level security;
grant select, insert, update on public.organization_memberships to authenticated;

create policy memberships_select_self
  on public.organization_memberships
  for select
  to authenticated
  using (user_id = auth.uid());

create policy memberships_select_admin_org
  on public.organization_memberships
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy memberships_insert_admin_org
  on public.organization_memberships
  for insert
  to authenticated
  with check (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

create policy memberships_update_admin_org
  on public.organization_memberships
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

-- roles: system roles (organization_id null) are visible to everyone
-- authenticated; organization-scoped custom roles (M1.5+) are visible only
-- within that organization. No mutation policy — role management is not a
-- built feature yet, so only migrations/service_role may write here.
alter table public.roles enable row level security;
grant select on public.roles to authenticated;

create policy roles_select_visible
  on public.roles
  for select
  to authenticated
  using (
    organization_id is null
    or organization_id = private.current_organization_id()
  );

-- permissions: a fixed, global capability catalog — not organization data,
-- safe to expose in full to any authenticated user.
alter table public.permissions enable row level security;
grant select on public.permissions to authenticated;

create policy permissions_select_all
  on public.permissions
  for select
  to authenticated
  using (true);

-- role_permissions: visible exactly where the underlying role is visible.
alter table public.role_permissions enable row level security;
grant select on public.role_permissions to authenticated;

create policy role_permissions_select_visible
  on public.role_permissions
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.roles r
      where r.id = role_permissions.role_id
        and (r.organization_id is null or r.organization_id = private.current_organization_id())
    )
  );
