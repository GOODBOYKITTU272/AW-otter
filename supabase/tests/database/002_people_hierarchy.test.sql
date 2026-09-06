-- M2 critical hierarchy/RLS test matrix. Self-contained fixtures, rolled
-- back at the end — independent of supabase/seed.sql and of 001_rls.test.sql
-- (pgTAP runs each file in its own transaction/connection).
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(23);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, each with admin/manager/AM(s), plus a department and
-- a team in Org A2 (Org B2 gets its own department/team too, used only as
-- cross-org targets for the boundary-violation tests).
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('11000000-0000-0000-0000-00000000000a', 'M2 Test Org A', 'm2-test-org-a'),
  ('11000000-0000-0000-0000-00000000000b', 'M2 Test Org B', 'm2-test-org-b');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '21000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-00000000000a', 'admin-a2@pgtap.test', 'Admin A2', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '21000000-0000-0000-0000-000000000002', '11000000-0000-0000-0000-00000000000a', 'manager-a2@pgtap.test', 'Manager A2', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '21000000-0000-0000-0000-000000000003', '11000000-0000-0000-0000-00000000000a', 'am-a2-1@pgtap.test', 'AM A2-1', id, '21000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '21000000-0000-0000-0000-000000000004', '11000000-0000-0000-0000-00000000000a', 'am-a2-2@pgtap.test', 'AM A2-2', id, '21000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '21000000-0000-0000-0000-000000001001', '11000000-0000-0000-0000-00000000000b', 'admin-b2@pgtap.test', 'Admin B2', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '21000000-0000-0000-0000-000000001002', '11000000-0000-0000-0000-00000000000b', 'manager-b2@pgtap.test', 'Manager B2', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.departments (id, organization_id, name) values
  ('31000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-00000000000a', 'Support'),
  ('31000000-0000-0000-0000-000000001001', '11000000-0000-0000-0000-00000000000b', 'B Dept');

insert into public.teams (id, organization_id, department_id, name, manager_membership_id) values
  ('41000000-0000-0000-0000-000000000001', '11000000-0000-0000-0000-00000000000a', '31000000-0000-0000-0000-000000000001', 'Support Team', '21000000-0000-0000-0000-000000000002'),
  ('41000000-0000-0000-0000-000000001001', '11000000-0000-0000-0000-00000000000b', '31000000-0000-0000-0000-000000001001', 'B Team', '21000000-0000-0000-0000-000000001002');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-a2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager-a2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-a2-1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-a2-2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000001001', 'authenticated', 'authenticated', 'admin-b2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '22000000-0000-0000-0000-000000001002', 'authenticated', 'authenticated', 'manager-b2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 1 & 2. Admin can read own org people; cannot read Org B people.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('22000000-0000-0000-0000-000000000001');

select is(
  (select count(*)::int from public.organization_memberships where organization_id = '11000000-0000-0000-0000-00000000000a'),
  4,
  '1. Admin A2 can read all 4 memberships in her own organization'
);

select is(
  (select count(*)::int from public.organization_memberships where organization_id = '11000000-0000-0000-0000-00000000000b'),
  0,
  '2. Admin A2 cannot read Org B2''s memberships'
);

-- ---------------------------------------------------------------------
-- 3 & 4. Admin can create in own org; cannot create in another org.
-- ---------------------------------------------------------------------
select lives_ok(
  $$
    insert into public.organization_memberships (organization_id, work_email, display_name, role_id)
    select '11000000-0000-0000-0000-00000000000a', 'new-hire@pgtap.test', 'New Hire', id
    from public.roles where key = 'account_manager' and organization_id is null
  $$,
  '3. Admin A2 can create a membership in her own organization'
);

select throws_ok(
  $$
    insert into public.organization_memberships (organization_id, work_email, display_name, role_id)
    select '11000000-0000-0000-0000-00000000000b', 'intruder@pgtap.test', 'Intruder', id
    from public.roles where key = 'account_manager' and organization_id is null
  $$,
  '42501',
  null,
  '4. Admin A2 cannot create a membership in Org B2'
);

-- ---------------------------------------------------------------------
-- 5. Manager assignment across organizations fails.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    update public.organization_memberships
    set manager_membership_id = '21000000-0000-0000-0000-000000001002'
    where id = '21000000-0000-0000-0000-000000000003'
  $$,
  'P0001',
  'Manager must belong to the same organization.',
  '5. Assigning an Org B2 manager to an Org A2 person fails'
);

-- ---------------------------------------------------------------------
-- 6. Team assignment across organizations fails.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    update public.organization_memberships
    set team_id = '41000000-0000-0000-0000-000000001001'
    where id = '21000000-0000-0000-0000-000000000003'
  $$,
  'P0001',
  'Team must belong to the same organization.',
  '6. Assigning an Org B2 team to an Org A2 person fails'
);

-- ---------------------------------------------------------------------
-- 7. Department assignment across organizations fails.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    update public.organization_memberships
    set department_id = '31000000-0000-0000-0000-000000001001'
    where id = '21000000-0000-0000-0000-000000000003'
  $$,
  'P0001',
  'Department must belong to the same organization.',
  '7. Assigning an Org B2 department to an Org A2 person fails'
);

-- ---------------------------------------------------------------------
-- 8. Team manager across organizations fails.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    update public.teams
    set manager_membership_id = '21000000-0000-0000-0000-000000001002'
    where id = '41000000-0000-0000-0000-000000000001'
  $$,
  'P0001',
  'Team manager must belong to the same organization.',
  '8. Assigning an Org B2 manager to an Org A2 team fails'
);

-- ---------------------------------------------------------------------
-- 9. Self-manager assignment fails.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    update public.organization_memberships
    set manager_membership_id = '21000000-0000-0000-0000-000000000003'
    where id = '21000000-0000-0000-0000-000000000003'
  $$,
  'P0001',
  'A person cannot manage themselves.',
  '9. AM A2-1 cannot be her own manager'
);

-- ---------------------------------------------------------------------
-- 10. Simple reporting cycle fails (A2-1 -> A2-2, then try A2-2 -> A2-1).
-- ---------------------------------------------------------------------
select lives_ok(
  $$
    update public.organization_memberships
    set manager_membership_id = '21000000-0000-0000-0000-000000000004'
    where id = '21000000-0000-0000-0000-000000000003'
  $$,
  '10a. AM A2-1''s manager can be set to AM A2-2'
);

select throws_ok(
  $$
    update public.organization_memberships
    set manager_membership_id = '21000000-0000-0000-0000-000000000003'
    where id = '21000000-0000-0000-0000-000000000004'
  $$,
  'P0001',
  'Circular reporting relationship detected.',
  '10b. Making AM A2-2 report to AM A2-1 (who already reports to A2-2) fails'
);

-- undo the 10a change so later assertions about AM A2-1's manager still hold
update public.organization_memberships
set manager_membership_id = '21000000-0000-0000-0000-000000000002'
where id = '21000000-0000-0000-0000-000000000003';

-- ---------------------------------------------------------------------
-- 11. Account Manager cannot administer another person.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('22000000-0000-0000-0000-000000000003');

update public.organization_memberships
set display_name = 'hacked-by-am'
where id = '21000000-0000-0000-0000-000000000004';

reset role;

select is(
  (select display_name from public.organization_memberships where id = '21000000-0000-0000-0000-000000000004'),
  'AM A2-2',
  '11. AM A2-1''s attempt to rename AM A2-2 has no effect'
);

-- ---------------------------------------------------------------------
-- 12 & 13. Duplicate work email within an org rejected; same email across
-- orgs allowed.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('22000000-0000-0000-0000-000000000001');

select throws_ok(
  $$
    insert into public.organization_memberships (organization_id, work_email, display_name, role_id)
    select '11000000-0000-0000-0000-00000000000a', 'am-a2-1@pgtap.test', 'Duplicate', id
    from public.roles where key = 'account_manager' and organization_id is null
  $$,
  '23505',
  null,
  '12. Duplicate work_email within the same organization is rejected'
);

reset role;
select pg_temp.tests_as('22000000-0000-0000-0000-000000001001');

select lives_ok(
  $$
    insert into public.organization_memberships (organization_id, work_email, display_name, role_id)
    select '11000000-0000-0000-0000-00000000000b', 'am-a2-1@pgtap.test', 'Same email different org', id
    from public.roles where key = 'account_manager' and organization_id is null
  $$,
  '13. The same work_email in a different organization is allowed'
);

-- ---------------------------------------------------------------------
-- 14. Deactivation preserves the record.
-- ---------------------------------------------------------------------
reset role;
select pg_temp.tests_as('22000000-0000-0000-0000-000000000001');

update public.organization_memberships
set status = 'deactivated'
where id = '21000000-0000-0000-0000-000000000004';

select is(
  (select status::text from public.organization_memberships where id = '21000000-0000-0000-0000-000000000004'),
  'deactivated',
  '14a. Deactivated membership status is persisted'
);

select isnt(
  (select deactivated_at from public.organization_memberships where id = '21000000-0000-0000-0000-000000000004'),
  null,
  '14b. deactivated_at is set'
);

select is(
  (select display_name from public.organization_memberships where id = '21000000-0000-0000-0000-000000000004'),
  'AM A2-2',
  '14c. Deactivation preserves identity (display_name intact, row not deleted)'
);

-- ---------------------------------------------------------------------
-- 15. Meeting Intelligence toggle persists correctly.
-- ---------------------------------------------------------------------
update public.organization_memberships
set meeting_ai_enabled = false
where id = '21000000-0000-0000-0000-000000000003';

select is(
  (select meeting_ai_enabled from public.organization_memberships where id = '21000000-0000-0000-0000-000000000003'),
  false,
  '15a. Meeting Intelligence can be turned off and persists'
);

update public.organization_memberships
set meeting_ai_enabled = true
where id = '21000000-0000-0000-0000-000000000003';

select is(
  (select meeting_ai_enabled from public.organization_memberships where id = '21000000-0000-0000-0000-000000000003'),
  true,
  '15b. Meeting Intelligence can be turned back on and persists'
);

-- ---------------------------------------------------------------------
-- Extra: departments/teams RLS (own-org read, cross-org denied).
-- ---------------------------------------------------------------------
reset role;
select pg_temp.tests_as('22000000-0000-0000-0000-000000000001');

select is(
  (select count(*)::int from public.departments where organization_id = '11000000-0000-0000-0000-00000000000a'),
  1,
  'extra. Admin A2 can read her own org''s department'
);

select is(
  (select count(*)::int from public.departments where organization_id = '11000000-0000-0000-0000-00000000000b'),
  0,
  'extra. Admin A2 cannot read Org B2''s department'
);

select is(
  (select count(*)::int from public.teams where organization_id = '11000000-0000-0000-0000-00000000000b'),
  0,
  'extra. Admin A2 cannot read Org B2''s team'
);

reset role;

select is(
  (select count(*)::int from public.audit_events where entity_id = '21000000-0000-0000-0000-000000000004' and action = 'membership.deactivated'),
  1,
  'extra. Deactivation produced an audit_events row'
);

select * from finish();
rollback;
