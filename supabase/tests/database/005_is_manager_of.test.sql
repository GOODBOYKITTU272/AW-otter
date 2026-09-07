-- M5 private.is_manager_of() test matrix. Self-contained fixtures, rolled
-- back at the end and independent of seed data or other pgTAP files.
--
-- Run with: supabase test db --local supabase/tests/database/005_is_manager_of.test.sql

begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs with active reporting chains, siblings, an unrelated
-- admin, and one chain broken by an inactive intermediate membership.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('14000000-0000-0000-0000-00000000000a', 'M5 Test Org A', 'm5-test-org-a'),
  ('14000000-0000-0000-0000-00000000000b', 'M5 Test Org B', 'm5-test-org-b');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '29000000-0000-0000-0000-000000000001', '14000000-0000-0000-0000-00000000000a', 'admin-m5-a@pgtap.test', 'Admin M5 A', id, 'active'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '29000000-0000-0000-0000-000000000002', '14000000-0000-0000-0000-00000000000a', 'senior-m5-a@pgtap.test', 'Senior M5 A', id, 'active'
from public.roles where key = 'senior_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000003', '14000000-0000-0000-0000-00000000000a', 'manager-m5-a1@pgtap.test', 'Manager M5 A1', id, '29000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000004', '14000000-0000-0000-0000-00000000000a', 'am-m5-a1@pgtap.test', 'AM M5 A1', id, '29000000-0000-0000-0000-000000000003', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000005', '14000000-0000-0000-0000-00000000000a', 'manager-m5-a2@pgtap.test', 'Manager M5 A2', id, '29000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000006', '14000000-0000-0000-0000-00000000000b', 'manager-m5-b@pgtap.test', 'Manager M5 B', id, null, 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000007', '14000000-0000-0000-0000-00000000000b', 'am-m5-b@pgtap.test', 'AM M5 B', id, '29000000-0000-0000-0000-000000000006', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000008', '14000000-0000-0000-0000-00000000000a', 'inactive-manager-m5-a@pgtap.test', 'Inactive Manager M5 A', id, '29000000-0000-0000-0000-000000000002', 'deactivated'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000009', '14000000-0000-0000-0000-00000000000a', 'am-broken-m5-a@pgtap.test', 'AM Broken M5 A', id, '29000000-0000-0000-0000-000000000008', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000101', '14000000-0000-0000-0000-00000000000a', 'deep-1-m5-a@pgtap.test', 'Deep 1 M5 A', id, '29000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000102', '14000000-0000-0000-0000-00000000000a', 'deep-2-m5-a@pgtap.test', 'Deep 2 M5 A', id, '29000000-0000-0000-0000-000000000101', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000103', '14000000-0000-0000-0000-00000000000a', 'deep-3-m5-a@pgtap.test', 'Deep 3 M5 A', id, '29000000-0000-0000-0000-000000000102', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000104', '14000000-0000-0000-0000-00000000000a', 'deep-4-m5-a@pgtap.test', 'Deep 4 M5 A', id, '29000000-0000-0000-0000-000000000103', 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '29000000-0000-0000-0000-000000000105', '14000000-0000-0000-0000-00000000000a', 'deep-5-m5-a@pgtap.test', 'Deep 5 M5 A', id, '29000000-0000-0000-0000-000000000104', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '2a000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-m5-a@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

select pg_temp.tests_as('2a000000-0000-0000-0000-000000000001');

select is(private.is_manager_of('29000000-0000-0000-0000-000000000003', '29000000-0000-0000-0000-000000000004'), true, '1. Direct manager is manager of employee');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000002', '29000000-0000-0000-0000-000000000004'), true, '2. Senior manager is manager through a two-level chain');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000005', '29000000-0000-0000-0000-000000000004'), false, '3. Sibling manager is not manager of employee');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000004', '29000000-0000-0000-0000-000000000003'), false, '4. Employee is not manager of their manager');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000001', '29000000-0000-0000-0000-000000000004'), false, '5. Admin is not implicitly manager of everyone');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000003', '29000000-0000-0000-0000-000000000007'), false, '6. Cross-organization pair is false');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000002', '29000000-0000-0000-0000-000000000009'), false, '7. Inactive intermediate membership breaks the chain');
select is(private.is_manager_of(null, '29000000-0000-0000-0000-000000000004'), false, '8a. Null manager argument is false');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000003', null), false, '8b. Null employee argument is false');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000003', '29000000-0000-0000-0000-000000000003'), false, '9. Same membership is not its own manager');
select is(private.is_manager_of('29000000-0000-0000-0000-000000000002', '29000000-0000-0000-0000-000000000105'), true, '10. Deeper active chain resolves correctly');

select * from finish();
rollback;
