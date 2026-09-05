-- Local development and test fixtures only. Clearly fake identities, never
-- real employee data. Organization-independent reference data (system
-- roles, permissions) lives in migrations, not here.
--
-- Memberships are seeded as 'invited' with no user_id — matching the real
-- flow. Running `pnpm run seed:users` afterwards creates the matching
-- Supabase Auth accounts, which the handle_new_user trigger then links and
-- activates automatically (see 20260906020004_organization_memberships.sql).

insert into public.organizations (id, name, slug, status, timezone) values
  ('00000000-0000-0000-0000-0000000000a1', 'Organization A (Test)', 'org-a-test', 'active', 'America/New_York'),
  ('00000000-0000-0000-0000-0000000000b1', 'Organization B (Test)', 'org-b-test', 'active', 'America/Los_Angeles');

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

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000020a1',
  '00000000-0000-0000-0000-0000000000a1',
  'manager@org-a.test',
  'Mia Manager (Org A)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'manager' and r.organization_id is null;

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000030a1',
  '00000000-0000-0000-0000-0000000000a1',
  'am-a@org-a.test',
  'Alex AM-A (Org A)',
  r.id,
  '00000000-0000-0000-0000-0000000020a1',
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;

insert into public.organization_memberships
  (id, organization_id, work_email, display_name, role_id, manager_membership_id, status, meeting_ai_enabled)
select
  '00000000-0000-0000-0000-0000000030a2',
  '00000000-0000-0000-0000-0000000000a1',
  'am-b@org-a.test',
  'Blair AM-B (Org A)',
  r.id,
  '00000000-0000-0000-0000-0000000020a1',
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;

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
  '00000000-0000-0000-0000-0000000030b1',
  '00000000-0000-0000-0000-0000000000b1',
  'am@org-b.test',
  'Bailey AM (Org B)',
  r.id,
  'invited',
  true
from public.roles r where r.key = 'account_manager' and r.organization_id is null;
