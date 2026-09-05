-- organization_id is null for system roles (shared across every
-- organization). Non-null values are reserved for organization-scoped
-- custom roles, a V1.5+ feature this migration does not implement.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete cascade,
  key text not null,
  name text not null,
  hierarchy_level int not null,
  is_system_role boolean not null default false,
  created_at timestamptz not null default now()
);

-- At most one system role per key (organization_id is null for all of them,
-- so a plain unique(organization_id, key) would not catch duplicates here —
-- Postgres treats NULL <> NULL).
create unique index roles_system_key_uq
  on public.roles (key)
  where organization_id is null;

-- At most one role per key within a given organization's custom roles.
create unique index roles_org_key_uq
  on public.roles (organization_id, key)
  where organization_id is not null;

-- System roles must use one of the four approved keys; organization-scoped
-- custom roles (is_system_role = false) are free to pick their own key.
alter table public.roles
  add constraint roles_system_role_key_check
  check (
    not is_system_role
    or key = any (enum_range(null::public.role_key)::text[])
  );

create table public.permissions (
  key text primary key,
  description text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_id, permission_key)
);

-- Seed data below is reference/configuration, not org-specific test
-- fixtures — it belongs in every environment (including production), unlike
-- supabase/seed.sql which only contains local/test organizations and people.

insert into public.roles (organization_id, key, name, hierarchy_level, is_system_role) values
  (null, 'admin', 'Admin', 100, true),
  (null, 'senior_manager', 'Senior Manager', 75, true),
  (null, 'manager', 'Manager', 50, true),
  (null, 'account_manager', 'Account Manager', 25, true);

insert into public.permissions (key, description) values
  ('organization.manage', 'Manage organization settings, roles and integrations'),
  ('people.manage', 'Add, update and deactivate people and reporting lines'),
  ('policy.manage', 'Configure recording, email, manager and retention policy'),
  ('meetings.read', 'View meetings the role is authorized to see'),
  ('transcripts.read', 'View meeting transcripts the role is authorized to see'),
  ('intelligence.read', 'View internal (non-client-safe) meeting intelligence'),
  ('exceptions.approve', 'Approve or reject recording exception requests'),
  ('audit.read', 'View the organization audit log');

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'admin' and r.organization_id is null;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
join public.permissions p
  on p.key in ('meetings.read', 'transcripts.read', 'intelligence.read', 'exceptions.approve')
where r.key in ('senior_manager', 'manager') and r.organization_id is null;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
join public.permissions p
  on p.key in ('meetings.read', 'transcripts.read')
where r.key = 'account_manager' and r.organization_id is null;
