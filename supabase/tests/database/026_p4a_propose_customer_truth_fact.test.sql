-- P4A customer_truth_facts_insert_proposed_meeting test matrix.
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Setup fixtures: Org P (Admin, AM P1, AM P2, Manager P) & Org Q (AM Q1)
insert into public.organizations (id, name, slug, email_domain) values
  ('49000000-0000-0000-0000-000000000001', 'P4A Test Org P', 'p4a-test-org-p', 'p4ap.test'),
  ('49000000-0000-0000-0000-000000000002', 'P4A Test Org Q', 'p4a-test-org-q', 'p4aq.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000001', '49000000-0000-0000-0000-000000000001', 'admin-p@p4atest.test', 'Admin P', id, 'active'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000002', '49000000-0000-0000-0000-000000000001', 'am-p1@p4atest.test', 'AM P1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000003', '49000000-0000-0000-0000-000000000001', 'am-p2@p4atest.test', 'AM P2', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '90000000-0000-0000-0000-000000000004', '49000000-0000-0000-0000-000000000001', 'manager-p@p4atest.test', 'Manager P', id, null, 'active'
from public.roles where key = 'manager' and organization_id is null;

update public.organization_memberships set manager_membership_id = '90000000-0000-0000-0000-000000000004'
where id = '90000000-0000-0000-0000-000000000002';

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000005', '49000000-0000-0000-0000-000000000002', 'am-q1@p4atest.test', 'AM Q1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@p4atest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@p4atest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@p4atest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'manager-p@p4atest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'am-q1@p4atest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000001' where id = '90000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000002' where id = '90000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000003' where id = '90000000-0000-0000-0000-000000000003';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000004' where id = '90000000-0000-0000-0000-000000000004';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000005' where id = '90000000-0000-0000-0000-000000000005';

-- Customer owned by AM P1
insert into public.customers (id, organization_id, name, owner_membership_id, created_by_membership_id) values
  ('92000000-0000-0000-0000-000000000001', '49000000-0000-0000-0000-000000000001', 'Acme P4A Candidate', '90000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000002');

-- Meeting linked to customer
insert into public.meetings (id, organization_id, owner_membership_id, customer_id, title, ical_uid, scheduled_start, scheduled_end) values
  ('93000000-0000-0000-0000-000000000001', '49000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002', '92000000-0000-0000-0000-000000000001', 'Discovery Call', 'ical-p4a-discovery-1', now() - interval '1 hour', now());

-- Helper to set session context
create or replace function set_p4a_user(p_user_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
end;
$$;

-- Test 1: Sibling AM P2 cannot insert proposed fact for AM P1's customer
select set_p4a_user('91000000-0000-0000-0000-000000000003');
set role authenticated;
select throws_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'role', '"SWE"'::jsonb, 'proposed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  '42501',
  null,
  'Sibling AM cannot insert proposed fact for another AM customer'
);

-- Test 2: Cross-org AM Q1 cannot insert proposed fact for Org P customer
select set_p4a_user('91000000-0000-0000-0000-000000000005');
select throws_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'role', '"SWE"'::jsonb, 'proposed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  '42501',
  null,
  'Cross-org AM cannot insert proposed fact for Org P customer'
);

-- Test 3: Authenticated user cannot insert status='confirmed' with source_type='meeting' (enforces proposal-only boundary)
select set_p4a_user('91000000-0000-0000-0000-000000000002');
select throws_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'role', '"SWE"'::jsonb, 'confirmed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  '42501',
  null,
  'Authenticated user cannot bypass proposal gate to insert confirmed meeting fact'
);

-- Test 4: Owner AM P1 can successfully insert a proposed fact with source_type='meeting'
select lives_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'relocation_pref', '"Austin, TX"'::jsonb, 'proposed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  'Owner AM can insert proposed fact'
);

-- Test 5: Inserted fact has status proposed and source_type meeting
select results_eq(
  $$ select status, source_type, field_key from public.customer_truth_facts where customer_id = '92000000-0000-0000-0000-000000000001'::uuid and field_key = 'relocation_pref' $$,
  $$ values ('proposed'::public.customer_truth_status, 'meeting'::public.customer_truth_source_type, 'relocation_pref'::text) $$,
  'Inserted fact has status proposed and source_type meeting'
);

-- Test 6: Manager P can also insert proposed fact for reporting AM P1's customer
select set_p4a_user('91000000-0000-0000-0000-000000000004');
select lives_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'target_salary', '150000'::jsonb, 'proposed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  'Manager of owner can insert proposed fact'
);

-- Test 7: Admin P can also insert proposed fact
select set_p4a_user('91000000-0000-0000-0000-000000000001');
select lives_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'notice_period', '"2 weeks"'::jsonb, 'proposed', 'meeting', '93000000-0000-0000-0000-000000000001')
  $$,
  'Admin can insert proposed fact'
);

-- Test 8: Cannot insert proposed fact if meeting belongs to a different customer
select set_p4a_user('91000000-0000-0000-0000-000000000002');
select throws_ok(
  $$
    insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id)
    values ('49000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'bad_field', '"val"'::jsonb, 'proposed', 'meeting', gen_random_uuid())
  $$,
  '42501',
  null,
  'Cannot insert proposed fact with unlinked meeting'
);

-- Test 9: Human confirmation works via confirm_customer_truth_fact
select lives_ok(
  $$
    select public.confirm_customer_truth_fact(
      (select id from public.customer_truth_facts where customer_id = '92000000-0000-0000-0000-000000000001'::uuid and field_key = 'relocation_pref')
    )
  $$,
  'Human AM can confirm the proposed customer truth fact'
);

-- Test 10: Fact status is now confirmed
select results_eq(
  $$ select status from public.customer_truth_facts where customer_id = '92000000-0000-0000-0000-000000000001'::uuid and field_key = 'relocation_pref' $$,
  $$ values ('confirmed'::public.customer_truth_status) $$,
  'Fact is promoted to confirmed status only upon human action'
);

-- Test 11: Human rejection works via reject_customer_truth_fact
select lives_ok(
  $$
    select public.reject_customer_truth_fact(
      (select id from public.customer_truth_facts where customer_id = '92000000-0000-0000-0000-000000000001'::uuid and field_key = 'target_salary'),
      'Candidate stated this was flexible, not a hard requirement'
    )
  $$,
  'Human AM can reject a proposed fact'
);

-- Test 12: Rejected fact status is rejected and raw evidence remains untouched
select results_eq(
  $$ select status, rejection_reason from public.customer_truth_facts where customer_id = '92000000-0000-0000-0000-000000000001'::uuid and field_key = 'target_salary' $$,
  $$ values ('rejected'::public.customer_truth_status, 'Candidate stated this was flexible, not a hard requirement'::text) $$,
  'Rejected fact has status rejected with reason, preserving audit history'
);

rollback;
