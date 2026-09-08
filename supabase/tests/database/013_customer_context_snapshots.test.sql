-- M10 amendment: customer_context_snapshots RLS/constraint test matrix.
-- Self-contained fixtures, rolled back at the end. Run with:
-- supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into public.organizations (id, name, slug, email_domain) values
  ('39000000-0000-0000-0000-000000000010', 'M10 CRM Test Org P', 'm10-crm-test-org-p', 'm10crmp.test'),
  ('39000000-0000-0000-0000-000000000011', 'M10 CRM Test Org Q', 'm10-crm-test-org-q', 'm10crmq.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-000000000010', 'admin-p@m10crmtest.test', 'Admin P', id, 'active'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-000000000010', 'am-p1@m10crmtest.test', 'AM P1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '90000000-0000-0000-0000-000000000003', '39000000-0000-0000-0000-000000000010', 'manager-p@m10crmtest.test', 'Manager P', id, null, 'active'
from public.roles where key = 'manager' and organization_id is null;

update public.organization_memberships set manager_membership_id = '90000000-0000-0000-0000-000000000003'
where id = '90000000-0000-0000-0000-000000000002';

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000004', '39000000-0000-0000-0000-000000000010', 'am-p2@m10crmtest.test', 'AM P2 (sibling)', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '90000000-0000-0000-0000-000000000005', '39000000-0000-0000-0000-000000000011', 'am-q1@m10crmtest.test', 'AM Q1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m10crmtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@m10crmtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'manager-p@m10crmtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-p2@m10crmtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '91000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'am-q1@m10crmtest.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000001' where id = '90000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000002' where id = '90000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000003' where id = '90000000-0000-0000-0000-000000000003';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000004' where id = '90000000-0000-0000-0000-000000000004';
update public.organization_memberships set user_id = '91000000-0000-0000-0000-000000000005' where id = '90000000-0000-0000-0000-000000000005';

insert into public.customers (id, organization_id, name, owner_membership_id, source_type, external_applywizz_id)
values ('92000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-000000000010', 'M10 CRM Test Customer', '90000000-0000-0000-0000-000000000002', 'manual', 'AWL-TEST-0001');

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

-- 1. Anon denied.
select pg_temp.tests_as_anon();
select throws_ok(
  $$ select count(*) from public.customer_context_snapshots $$,
  '42501', null, '1a. Anon cannot select customer_context_snapshots'
);

-- 2. No authenticated write grant — hydration is server-triggered only.
select pg_temp.tests_as('91000000-0000-0000-0000-000000000002');
select throws_ok(
  $$ insert into public.customer_context_snapshots (organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint)
     values ('39000000-0000-0000-0000-000000000010', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', '{}'::jsonb, 'fp1') $$,
  '42501', null, '2a. Authenticated cannot directly INSERT customer_context_snapshots'
);

-- 3. Service-role writes + org-consistency + constraints.
reset role;

select throws_ok(
  $$ insert into public.customer_context_snapshots (organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint)
     values ('39000000-0000-0000-0000-000000000011', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', '{}'::jsonb, 'fp1') $$,
  'P0001', null, '3a. customer_context_snapshots.customer_id must belong to the same organization'
);

select lives_ok(
  $$ insert into public.customer_context_snapshots (id, organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint)
     values ('93000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-000000000010', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', '{"truthFields":{"locations":["Austin"]}}'::jsonb, 'fp-real-1') $$,
  '3b. A real snapshot insert succeeds'
);

-- Idempotency: identical content_fingerprint for the same customer is rejected.
select throws_ok(
  $$ insert into public.customer_context_snapshots (organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint)
     values ('39000000-0000-0000-0000-000000000010', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', '{"truthFields":{"locations":["Austin"]}}'::jsonb, 'fp-real-1') $$,
  '23505', null, '3c. A duplicate (customer_id, content_fingerprint) is rejected — real idempotency enforcement, not a race-prone check-then-insert'
);

-- A genuinely different fingerprint for the SAME customer is allowed (a
-- real content change). created_at is explicit here (rather than the
-- column default) only because this whole test file runs inside ONE
-- transaction, where now() resolves identically for every statement —
-- real service-role hydration calls are always separate transactions
-- with genuinely distinct now() values, so this is a test-fixture
-- artifact, not a production concern.
select lives_ok(
  $$ insert into public.customer_context_snapshots (organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint, created_at)
     values ('39000000-0000-0000-0000-000000000010', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', '{"truthFields":{"locations":["Boston"]}}'::jsonb, 'fp-real-2', now() + interval '1 second') $$,
  '3d. A genuinely different fingerprint for the same customer is accepted (real content change)'
);

select throws_ok(
  $$ insert into public.customer_context_snapshots (organization_id, customer_id, external_applywizz_id, normalized_data, content_fingerprint)
     values ('39000000-0000-0000-0000-000000000010', '92000000-0000-0000-0000-000000000001', 'AWL-TEST-0001', jsonb_build_object('padding', repeat('x', 20000)), 'fp-oversized') $$,
  '23514', null, '3e. An oversized normalized_data payload is rejected (defense-in-depth bound)'
);

-- 4. Select visibility: owner AM, admin, manager-in-tree, sibling AM denied, cross-org denied.
select pg_temp.tests_as('91000000-0000-0000-0000-000000000002'); -- AM P1, owner
select is(
  (select count(*)::int from public.customer_context_snapshots where customer_id = '92000000-0000-0000-0000-000000000001'),
  2,
  '4a. The owning AM can see both real snapshots'
);

select pg_temp.tests_as('91000000-0000-0000-0000-000000000001'); -- Admin P
select is(
  (select count(*)::int from public.customer_context_snapshots where customer_id = '92000000-0000-0000-0000-000000000001'),
  2,
  '4b. Org admin can see snapshots org-wide'
);

select pg_temp.tests_as('91000000-0000-0000-0000-000000000003'); -- Manager P, manages AM P1, has intelligence.read
select is(
  (select count(*)::int from public.customer_context_snapshots where customer_id = '92000000-0000-0000-0000-000000000001'),
  2,
  '4c. Manager P (in AM P1''s reporting line, with intelligence.read) can see the snapshots'
);

select pg_temp.tests_as('91000000-0000-0000-0000-000000000004'); -- AM P2, sibling, no relationship to AM P1
select is(
  (select count(*)::int from public.customer_context_snapshots where customer_id = '92000000-0000-0000-0000-000000000001'),
  0,
  '4d. A sibling AM with no relationship to the owner cannot see the snapshots'
);

select pg_temp.tests_as('91000000-0000-0000-0000-000000000005'); -- AM Q1, cross-org
select is(
  (select count(*)::int from public.customer_context_snapshots where customer_id = '92000000-0000-0000-0000-000000000001'),
  0,
  '4e. Cross-org membership cannot see the snapshots'
);

-- 5. "Latest snapshot" query pattern (what the domain layer's
--    getEffectiveCustomerTruth relies on) returns the most recent row.
select pg_temp.tests_as('91000000-0000-0000-0000-000000000002');
select is(
  (select content_fingerprint from public.customer_context_snapshots
     where customer_id = '92000000-0000-0000-0000-000000000001'
     order by created_at desc limit 1),
  'fp-real-2',
  '5a. Ordering by created_at desc surfaces the most recent snapshot'
);

select * from finish();
rollback;
