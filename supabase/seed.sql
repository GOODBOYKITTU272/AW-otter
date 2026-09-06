-- Local development and test fixtures only. Clearly fake identities, never
-- real employee data. Organization-independent reference data (system
-- roles, permissions) lives in migrations, not here.
--
-- Memberships are seeded as 'invited' with no user_id — matching the real
-- flow. Running `pnpm run seed:users` afterwards creates the matching
-- Supabase Auth accounts, which the handle_new_user trigger then links and
-- activates automatically (see 20260906020004_organization_memberships.sql).
--
-- Org A hierarchy: Senior Manager A -> Manager A -> AM A1, AM A2, in
-- department "Customer Success" / team "Account Management".
-- Org B: Admin B, Manager B -> AM B1 (no department/team — not needed to
-- prove cross-org isolation, which is what Org B fixtures are for).

insert into public.organizations (id, name, slug, status, timezone) values
  ('00000000-0000-0000-0000-0000000000a1', 'Organization A (Test)', 'org-a-test', 'active', 'America/New_York'),
  ('00000000-0000-0000-0000-0000000000b1', 'Organization B (Test)', 'org-b-test', 'active', 'America/Los_Angeles');

-- Admin A (no manager, no department/team)
insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000010a1',
  '00000000-0000-0000-0000-0000000000a1',
  'admin@org-a.test',
  'Ada Admin (Org A)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'admin' and r.organization_id is null;

-- Senior Manager A (top of the Org A reporting chain seeded here)
insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000015a1',
  '00000000-0000-0000-0000-0000000000a1',
  'senior-manager@org-a.test',
  'Sam Senior Manager (Org A)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'senior_manager' and r.organization_id is null;

-- Manager A reports to Senior Manager A
insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000020a1',
  '00000000-0000-0000-0000-0000000000a1',
  'manager@org-a.test',
  'Mia Manager (Org A)',
  r.id,
  '00000000-0000-0000-0000-0000000015a1',
  'invited',
  true
from public.roles r where r.key = 'manager' and r.organization_id is null;

insert into public.departments (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000040a1', '00000000-0000-0000-0000-0000000000a1', 'Customer Success');

insert into public.teams (id, organization_id, department_id, name, manager_membership_id) values
  (
    '00000000-0000-0000-0000-0000000050a1',
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000040a1',
    'Account Management',
    '00000000-0000-0000-0000-0000000020a1'
  );

update public.organization_memberships
set department_id = '00000000-0000-0000-0000-0000000040a1'
where id = '00000000-0000-0000-0000-0000000020a1';

-- AM A1, AM A2 report to Manager A, in Customer Success / Account Management
insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, department_id, team_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000030a1',
  '00000000-0000-0000-0000-0000000000a1',
  'am-a1@org-a.test',
  'AM A1 (Org A)',
  r.id,
  '00000000-0000-0000-0000-0000000020a1',
  '00000000-0000-0000-0000-0000000040a1',
  '00000000-0000-0000-0000-0000000050a1',
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, department_id, team_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000030a2',
  '00000000-0000-0000-0000-0000000000a1',
  'am-a2@org-a.test',
  'AM A2 (Org A)',
  r.id,
  '00000000-0000-0000-0000-0000000020a1',
  '00000000-0000-0000-0000-0000000040a1',
  '00000000-0000-0000-0000-0000000050a1',
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;

-- Org B: Admin B, Manager B -> AM B1
insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000010b1',
  '00000000-0000-0000-0000-0000000000b1',
  'admin@org-b.test',
  'Bo Admin (Org B)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'admin' and r.organization_id is null;

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000020b1',
  '00000000-0000-0000-0000-0000000000b1',
  'manager@org-b.test',
  'Max Manager (Org B)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'manager' and r.organization_id is null;

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000030b1',
  '00000000-0000-0000-0000-0000000000b1',
  'am-b1@org-b.test',
  'AM B1 (Org B)',
  r.id,
  '00000000-0000-0000-0000-0000000020b1',
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;
