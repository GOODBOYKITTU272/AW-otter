-- M14 Manager Experience: Team Portfolio / Manager Actions / Manager
-- Meetings all depend on getPortfolioOverview's very first query
-- (`select * from customers`, no explicit filter) being correctly scoped
-- by customers_select_manager_scope RLS alone. That policy already
-- existed (M10-era), but had no dedicated pgTAP coverage of its own —
-- only customer_truth_facts/call_records manager-scope were directly
-- tested. If this policy were ever broken, the whole Team Portfolio page
-- would silently show wrong (or missing) data with no test catching it.
--
-- Fixtures: two managers in the SAME org, each managing a different AM
-- (proving cross-branch denial within one org, not just cross-org), plus
-- a cross-org manager.

begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

insert into public.organizations (id, name, slug, email_domain) values
  ('98000000-0000-0000-0000-00000000000a', 'M14 Test Org P', 'm14-test-org-p', 'm14p.test'),
  ('98000000-0000-0000-0000-00000000000b', 'M14 Test Org Q', 'm14-test-org-q', 'm14q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-000000000006', '98000000-0000-0000-0000-00000000000a', 'senior-manager@m14test.test', 'Senior Manager (manages Manager 1, transitively AM1)', id, 'invited'
from public.roles where key = 'senior_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '98100000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-00000000000a', 'manager-1@m14test.test', 'Manager 1 (manages AM1)', id, '98100000-0000-0000-0000-000000000006', 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-000000000002', '98000000-0000-0000-0000-00000000000a', 'manager-2@m14test.test', 'Manager 2 (manages AM2, different branch)', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '98100000-0000-0000-0000-000000000003', '98000000-0000-0000-0000-00000000000a', 'am-1@m14test.test', 'AM 1 (reports to Manager 1)', id, '98100000-0000-0000-0000-000000000001', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '98100000-0000-0000-0000-000000000004', '98000000-0000-0000-0000-00000000000a', 'am-2@m14test.test', 'AM 2 (reports to Manager 2)', id, '98100000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-000000000005', '98000000-0000-0000-0000-00000000000b', 'manager-q@m14test.test', 'Manager Q (cross-org)', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'manager-1@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager-2@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-1@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-2@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  -- is_manager_of requires status='active' on BOTH the manager and the
  -- employee membership — the on-signup trigger only sets that via a
  -- matching auth.users row, so AM1/AM2 need one too, not just the
  -- managers (a real fixture mistake this test itself caught).
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'manager-q@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  -- is_manager_of's chain walk ALSO requires every intermediate node
  -- (Manager 1, here) to be active to fetch its own manager_membership_id
  -- — a 2-level transitive check needs all three (senior manager,
  -- manager, AM) active, not just the two endpoints.
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'senior-manager@m14test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('98300000-0000-0000-0000-000000000001', '98000000-0000-0000-0000-00000000000a', 'AM1 Customer', '98100000-0000-0000-0000-000000000003', 'manual');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- Manager 1 (manages AM1, the customer's owner): visible.
select pg_temp.tests_as('98200000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  1, '1. Reporting-line manager sees the customer via customers_select_manager_scope'
);
select is(
  (select name from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  'AM1 Customer', '2. Reporting-line manager sees the real customer name (not filtered/redacted)'
);

-- Manager 2 (same org, manages a DIFFERENT AM — different branch): must
-- NOT see it, proving this isn't "any manager in the org" but genuinely
-- reporting-line-scoped.
reset role;
select pg_temp.tests_as('98200000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  0, '3. A DIFFERENT manager in the same org (not in this AM''s reporting line) cannot see the customer'
);

-- Cross-org manager: must not see it.
reset role;
select pg_temp.tests_as('98200000-0000-0000-0000-000000000005');
select is(
  (select count(*)::int from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  0, '4. Cross-org manager cannot see the customer'
);

-- Anon/unauthenticated: denied entirely.
reset role;
set role anon;
select throws_ok(
  $$ select count(*) from public.customers $$,
  '42501', null,
  '5. anon cannot select customers at all'
);
reset role;

-- Manager 1 again, confirming the visibility isn't a one-shot artifact of
-- test ordering (re-check after the intervening role switches above).
select pg_temp.tests_as('98200000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  1, '6. Reporting-line manager still sees the customer after role-switch churn'
);
reset role;

-- Senior Manager (manages Manager 1, TRANSITIVELY manages AM1 — two
-- levels, matching this product's real seeded hierarchy of Senior
-- Manager -> Manager -> AM): must also see the customer, proving
-- is_manager_of's chain walk is genuinely multi-level, not just direct.
select pg_temp.tests_as('98200000-0000-0000-0000-000000000006');
select is(
  (select count(*)::int from public.customers where id = '98300000-0000-0000-0000-000000000001'),
  1, '7. Senior manager (two levels up) sees the customer via transitive is_manager_of'
);
reset role;

select * from finish();
rollback;
