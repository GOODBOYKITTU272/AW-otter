-- M7A revised scheduler integration: scheduler_calls table + the schema
-- changes it depends on (customers.external_applywizz_id, the revised
-- call_type/call_type_source enums). Self-contained fixtures, rolled back
-- at the end. Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, mirroring 008's shape.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, email_domain) values
  ('29000000-0000-0000-0000-00000000000a', 'M7A Sched Test Org P', 'm7a-sched-test-org-p', 'schedp.test'),
  ('29000000-0000-0000-0000-00000000000b', 'M7A Sched Test Org Q', 'm7a-sched-test-org-q', 'schedq.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '52000000-0000-0000-0000-000000000001', '29000000-0000-0000-0000-00000000000a', 'admin-p@schedtest.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '52000000-0000-0000-0000-000000000002', '29000000-0000-0000-0000-00000000000a', 'am-p1@schedtest.test', 'AM P1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '52000000-0000-0000-0000-000000000003', '29000000-0000-0000-0000-00000000000a', 'am-p2@schedtest.test', 'AM P2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '52000000-0000-0000-0000-000000000004', '29000000-0000-0000-0000-00000000000b', 'am-q1@schedtest.test', 'AM Q1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '53000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@schedtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '53000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@schedtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '53000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@schedtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '53000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-q1@schedtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.customers (id, organization_id, name, owner_membership_id, source_type, external_applywizz_id) values
  ('54000000-0000-0000-0000-000000000001', '29000000-0000-0000-0000-00000000000a', 'Customer P1', '52000000-0000-0000-0000-000000000002', 'external_scheduler', 'AWL-1001');

insert into public.scheduler_calls (
  id, organization_id, external_call_id, customer_id, external_applywizz_id,
  owner_membership_id, external_am_email, external_type, canonical_call_type,
  scheduled_at, external_status
) values (
  '55000000-0000-0000-0000-000000000001', '29000000-0000-0000-0000-00000000000a', 'sched-ext-1', '54000000-0000-0000-0000-000000000001', 'AWL-1001',
  '52000000-0000-0000-0000-000000000002', 'am-p1@schedtest.test', 'DISCOVERY', 'discovery',
  now() + interval '1 day', 'SCHEDULED'
);

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

create or replace function pg_temp.tests_as_anon() returns void as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 1. Anon denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.scheduler_calls $$, '42501', null, '1a. Anon cannot select scheduler_calls');

-- ---------------------------------------------------------------------
-- 2. Select visibility: owning AM, non-owning sibling denied, admin
--    org-wide, cross-org denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('53000000-0000-0000-0000-000000000002'); -- AM P1, current owner of the call

select is(
  (select external_type from public.scheduler_calls where id = '55000000-0000-0000-0000-000000000001'),
  'DISCOVERY',
  '2a. The call''s current owner (AM P1) can see it'
);

select pg_temp.tests_as('53000000-0000-0000-0000-000000000003'); -- AM P2, sibling, doesn't own this call

select is(
  (select count(*)::int from public.scheduler_calls where id = '55000000-0000-0000-0000-000000000001'),
  0,
  '2b. A sibling AM who doesn''t own the call cannot see it'
);

select pg_temp.tests_as('53000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select external_type from public.scheduler_calls where id = '55000000-0000-0000-0000-000000000001'),
  'DISCOVERY',
  '2c. Org admin can see the call org-wide'
);

select pg_temp.tests_as('53000000-0000-0000-0000-000000000004'); -- AM Q1, cross-org

select is(
  (select count(*)::int from public.scheduler_calls where id = '55000000-0000-0000-0000-000000000001'),
  0,
  '2d. Cross-org membership cannot see the call'
);

-- ---------------------------------------------------------------------
-- 3. No authenticated write grant at all — pure ingestion table.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('53000000-0000-0000-0000-000000000002'); -- AM P1, owner

select throws_ok(
  $$ update public.scheduler_calls set external_status = 'COMPLETED' where id = '55000000-0000-0000-0000-000000000001' $$,
  '42501', null, '3a. No authenticated role can update scheduler_calls (service_role only)'
);

select throws_ok(
  $$ insert into public.scheduler_calls (organization_id, external_call_id, customer_id, external_applywizz_id, owner_membership_id, external_am_email, external_type, canonical_call_type, scheduled_at, external_status)
     values ('29000000-0000-0000-0000-00000000000a', 'sched-ext-2', '54000000-0000-0000-0000-000000000001', 'AWL-1001', '52000000-0000-0000-0000-000000000002', 'am-p1@schedtest.test', 'DISCOVERY', 'discovery', now(), 'SCHEDULED') $$,
  '42501', null, '3b. No authenticated role can insert scheduler_calls (service_role only)'
);

-- ---------------------------------------------------------------------
-- 4. Idempotency / identity constraints (as service_role-equivalent —
--    the table owner bypasses RLS, same convention 008 uses for
--    constraint-only checks).
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$ insert into public.scheduler_calls (organization_id, external_call_id, customer_id, external_applywizz_id, owner_membership_id, external_am_email, external_type, canonical_call_type, scheduled_at, external_status)
     values ('29000000-0000-0000-0000-00000000000a', 'sched-ext-1', '54000000-0000-0000-0000-000000000001', 'AWL-1001', '52000000-0000-0000-0000-000000000002', 'am-p1@schedtest.test', 'DISCOVERY', 'discovery', now(), 'SCHEDULED') $$,
  '23505', null, '4a. (organization_id, external_call_id) must be unique — repeated sync of the same scheduler row is an upsert target, not a duplicate row'
);

select lives_ok(
  $$ update public.scheduler_calls set external_status = 'COMPLETED', scheduled_at = now() + interval '2 days' where id = '55000000-0000-0000-0000-000000000001' $$,
  '4b. Refreshing an existing row''s descriptive fields (status, reschedule) is a plain update, not blocked by the identity constraint'
);

select throws_ok(
  $$ insert into public.scheduler_calls (organization_id, external_call_id, customer_id, external_applywizz_id, owner_membership_id, external_am_email, external_type, canonical_call_type, scheduled_at, external_status)
     values ('29000000-0000-0000-0000-00000000000b', 'sched-ext-1', '54000000-0000-0000-0000-000000000001', 'AWL-1001', '52000000-0000-0000-0000-000000000004', 'am-q1@schedtest.test', 'DISCOVERY', 'discovery', now(), 'SCHEDULED') $$,
  'P0001', null, '4c. A cross-org customer_id is rejected by the org-consistency trigger even with a matching organization_id'
);

-- ---------------------------------------------------------------------
-- 5. Org-consistency trigger: owner_membership_id and meeting_id.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.scheduler_calls (organization_id, external_call_id, customer_id, external_applywizz_id, owner_membership_id, external_am_email, external_type, canonical_call_type, scheduled_at, external_status)
     values ('29000000-0000-0000-0000-00000000000a', 'sched-ext-3', '54000000-0000-0000-0000-000000000001', 'AWL-1001', '52000000-0000-0000-0000-000000000004', 'am-q1@schedtest.test', 'DISCOVERY', 'discovery', now(), 'SCHEDULED') $$,
  'P0001', null, '5a. A cross-org owner_membership_id is rejected by the org-consistency trigger'
);

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('56000000-0000-0000-0000-000000000001', '29000000-0000-0000-0000-00000000000b', '52000000-0000-0000-0000-000000000004', 'microsoft', 'ical-sched-q1', 'Org Q meeting', 'teams', 'https://meet.example/q1', now() + interval '1 hour', now() + interval '2 hours', 'record');

select throws_ok(
  $$ update public.scheduler_calls set meeting_id = '56000000-0000-0000-0000-000000000001' where id = '55000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '5b. A cross-org meeting_id is rejected by the org-consistency trigger'
);

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('56000000-0000-0000-0000-000000000002', '29000000-0000-0000-0000-00000000000a', '52000000-0000-0000-0000-000000000002', 'microsoft', 'ical-sched-p1', 'Org P meeting', 'teams', 'https://meet.example/p1', now() + interval '1 hour', now() + interval '2 hours', 'record');

select lives_ok(
  $$ update public.scheduler_calls set meeting_id = '56000000-0000-0000-0000-000000000002' where id = '55000000-0000-0000-0000-000000000001' $$,
  '5c. A same-org meeting_id is accepted'
);

-- ---------------------------------------------------------------------
-- 6. customers.external_applywizz_id: org-scoped uniqueness, NULLs
--    unconstrained, same lead_id allowed to exist independently in a
--    DIFFERENT org.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, source_type, external_applywizz_id)
     values ('29000000-0000-0000-0000-00000000000a', 'Duplicate lead', '52000000-0000-0000-0000-000000000002', 'external_scheduler', 'AWL-1001') $$,
  '23505', null, '6a. (organization_id, external_applywizz_id) must be unique when set — same lead_id cannot create a second Signal customer in the same org'
);

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, source_type, external_applywizz_id)
     values ('29000000-0000-0000-0000-00000000000b', 'Same lead id, different org', '52000000-0000-0000-0000-000000000004', 'external_scheduler', 'AWL-1001') $$,
  '6b. The same lead_id string is allowed to exist independently in a different organization'
);

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, source_type)
     values ('29000000-0000-0000-0000-00000000000a', 'Manual, no lead id', '52000000-0000-0000-0000-000000000002', 'manual') $$,
  '6c. A manual customer with a NULL external_applywizz_id does not collide with anything (multiple NULLs allowed)'
);

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, source_type)
     values ('29000000-0000-0000-0000-00000000000a', 'Manual, no lead id #2', '52000000-0000-0000-0000-000000000002', 'manual') $$,
  '6d. A second manual customer with a NULL external_applywizz_id also does not collide'
);

-- ---------------------------------------------------------------------
-- 7. Revised enum values are real and usable.
-- ---------------------------------------------------------------------
select lives_ok(
  $$ update public.meetings set call_type = 'progress', call_type_source = 'external_scheduler' where id = '56000000-0000-0000-0000-000000000002' $$,
  '7a. call_type=''progress'' and call_type_source=''external_scheduler'' are valid enum values'
);

select throws_ok(
  $$ update public.meetings set call_type = 'day15_progress' where id = '56000000-0000-0000-0000-000000000002' $$,
  '22P02', null, '7b. The old value ''day15_progress'' no longer exists — ''progress'' replaced it'
);

select lives_ok(
  $$ update public.meetings set call_type_source = 'manual' where id = '56000000-0000-0000-0000-000000000002' $$,
  '7c. call_type_source=''manual'' is a valid enum value'
);

select throws_ok(
  $$ update public.meetings set call_type_source = 'external' where id = '56000000-0000-0000-0000-000000000002' $$,
  '22P02', null, '7d. The old placeholder value ''external'' no longer exists'
);

select is(
  (select source_type::text from public.customers where name = 'Customer P1'),
  'external_scheduler',
  '7e. customers.source_type accepts ''external_scheduler'''
);

select * from finish();
rollback;
