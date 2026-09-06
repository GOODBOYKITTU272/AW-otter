-- M2: company structure. departments/teams are org-scoped reference data;
-- no cross-organization sharing.

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index departments_org_name_uq on public.departments (organization_id, name);

create trigger departments_set_updated_at
  before update on public.departments
  for each row execute function public.set_updated_at();

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  department_id uuid references public.departments (id) on delete set null,
  name text not null,
  manager_membership_id uuid references public.organization_memberships (id) on delete set null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- "Appropriately unique": scoped to organization + department. A
-- department-less team (department_id null) is not deduplicated against
-- other department-less teams by this index — Postgres unique indexes treat
-- NULLs as distinct — which matches the ambiguity in "where appropriate"
-- rather than inventing a stricter rule the brief didn't ask for.
create unique index teams_org_department_name_uq on public.teams (organization_id, department_id, name);

create index teams_manager_idx on public.teams (manager_membership_id);

create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

-- Cross-organization consistency for teams themselves (department and
-- manager must belong to the same org as the team). Membership-side
-- consistency (employee/department/team/manager same-org, self-management,
-- cycles) is enforced in 20260906020009_hierarchy_validation.sql.
create or replace function public.validate_team_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_department_org uuid;
  v_manager_org uuid;
begin
  if new.department_id is not null then
    select organization_id into v_department_org from public.departments where id = new.department_id;
    if v_department_org is null or v_department_org <> new.organization_id then
      raise exception 'Team department must belong to the same organization.';
    end if;
  end if;

  if new.manager_membership_id is not null then
    select organization_id into v_manager_org from public.organization_memberships where id = new.manager_membership_id;
    if v_manager_org is null or v_manager_org <> new.organization_id then
      raise exception 'Team manager must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger teams_validate_organization
  before insert or update on public.teams
  for each row execute function public.validate_team_organization();
