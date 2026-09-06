-- Completes the M1-deferred fields now that departments/teams exist.
-- manager_membership_id already exists from M1.
alter table public.organization_memberships
  add column department_id uuid references public.departments (id) on delete set null,
  add column team_id uuid references public.teams (id) on delete set null;

create index organization_memberships_department_idx on public.organization_memberships (department_id);
create index organization_memberships_team_idx on public.organization_memberships (team_id);
