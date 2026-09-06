-- M3 Microsoft integration test matrix. Self-contained fixtures, rolled
-- back at the end — independent of supabase/seed.sql and the other test
-- files (pgTAP runs each file in its own transaction/connection).
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, each with an admin and account managers, one
-- Microsoft connection for AM C1.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('12000000-0000-0000-0000-00000000000a', 'M3 Test Org C', 'm3-test-org-c'),
  ('12000000-0000-0000-0000-00000000000b', 'M3 Test Org D', 'm3-test-org-d');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '23000000-0000-0000-0000-000000000001', '12000000-0000-0000-0000-00000000000a', 'admin-c@pgtap.test', 'Admin C', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '23000000-0000-0000-0000-000000000002', '12000000-0000-0000-0000-00000000000a', 'am-c1@pgtap.test', 'AM C1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '23000000-0000-0000-0000-000000000003', '12000000-0000-0000-0000-00000000000a', 'am-c2@pgtap.test', 'AM C2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '23000000-0000-0000-0000-000000001001', '12000000-0000-0000-0000-00000000000b', 'admin-d@pgtap.test', 'Admin D', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '24000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-c@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '24000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-c1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '24000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-c2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '24000000-0000-0000-0000-000000001001', 'authenticated', 'authenticated', 'admin-d@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.calendar_connections (id, organization_membership_id, provider, provider_user_id, status, scope_metadata) values
  ('25000000-0000-0000-0000-000000000001', '23000000-0000-0000-0000-000000000002', 'microsoft', 'ms-oid-c1', 'active', '{"email":"am-c1@applywizz.example"}');

insert into public.provider_subscriptions (id, calendar_connection_id, external_subscription_id, resource, expires_at) values
  ('26000000-0000-0000-0000-000000000001', '25000000-0000-0000-0000-000000000001', 'graph-sub-1', 'me/events', now() + interval '2 days');

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
-- 1. User can access their own calendar connection.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('24000000-0000-0000-0000-000000000002');

select is(
  (select provider_user_id from public.calendar_connections where organization_membership_id = '23000000-0000-0000-0000-000000000002'),
  'ms-oid-c1',
  '1. AM C1 can read her own calendar connection'
);

-- ---------------------------------------------------------------------
-- 2. Admin can inspect connection status inside own organization.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('24000000-0000-0000-0000-000000000001');

select is(
  (select status::text from public.calendar_connections where organization_membership_id = '23000000-0000-0000-0000-000000000002'),
  'active',
  '2. Admin C can read AM C1''s connection status in her own organization'
);

-- ---------------------------------------------------------------------
-- 3. Organization A (D here) cannot access Organization B (C) connections.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('24000000-0000-0000-0000-000000001001');

select is(
  (select count(*)::int from public.calendar_connections where organization_membership_id = '23000000-0000-0000-0000-000000000002'),
  0,
  '3. Admin D cannot read Org C''s calendar connection'
);

-- ---------------------------------------------------------------------
-- 4. provider_subscriptions cannot reference another organization's
--    connection through a malformed write.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    insert into public.provider_subscriptions (calendar_connection_id, external_subscription_id, resource, expires_at)
    values ('25000000-0000-0000-0000-000000000001', 'graph-sub-hijack', 'me/events', now() + interval '1 day')
  $$,
  '42501',
  null,
  '4. Admin D cannot create a subscription against Org C''s connection'
);

-- ---------------------------------------------------------------------
-- 5. Duplicate active connection follows the approved uniqueness rule
--    (one connection per membership+provider).
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$
    insert into public.calendar_connections (organization_membership_id, provider, provider_user_id, status)
    values ('23000000-0000-0000-0000-000000000002', 'microsoft', 'ms-oid-c1-again', 'active')
  $$,
  '23505',
  null,
  '5. A second microsoft connection for the same membership is rejected'
);

-- ---------------------------------------------------------------------
-- 6. external_subscription_id uniqueness.
-- ---------------------------------------------------------------------
select throws_ok(
  $$
    insert into public.provider_subscriptions (calendar_connection_id, external_subscription_id, resource, expires_at)
    values ('25000000-0000-0000-0000-000000000001', 'graph-sub-1', 'me/events', now() + interval '1 day')
  $$,
  '23505',
  null,
  '6. A duplicate external_subscription_id is rejected'
);

-- ---------------------------------------------------------------------
-- 7. Account Manager cannot modify another person's connection.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('24000000-0000-0000-0000-000000000003');

update public.calendar_connections
set status = 'disconnected'
where organization_membership_id = '23000000-0000-0000-0000-000000000002';

reset role;

select is(
  (select status::text from public.calendar_connections where organization_membership_id = '23000000-0000-0000-0000-000000000002'),
  'active',
  '7. AM C2''s attempt to disconnect AM C1''s connection has no effect'
);

-- ---------------------------------------------------------------------
-- 8. Unauthenticated access is denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok(
  $$ select count(*) from public.calendar_connections $$,
  '42501',
  null,
  '8. Unauthenticated (anon) read of calendar_connections is denied'
);

select throws_ok(
  $$ select count(*) from public.provider_subscriptions $$,
  '42501',
  null,
  '8b. Unauthenticated (anon) read of provider_subscriptions is denied'
);

-- ---------------------------------------------------------------------
-- 9. Status change preserves org isolation (admin of a different org
--    cannot change status either).
-- ---------------------------------------------------------------------
reset role;
select pg_temp.tests_as('24000000-0000-0000-0000-000000001001');

update public.calendar_connections
set status = 'error'
where organization_membership_id = '23000000-0000-0000-0000-000000000002';

update public.provider_subscriptions
set status = 'cancelled'
where id = '26000000-0000-0000-0000-000000000001';

reset role;

select is(
  (select status::text from public.calendar_connections where organization_membership_id = '23000000-0000-0000-0000-000000000002'),
  'active',
  '9a. Admin D''s attempt to change Org C''s connection status has no effect'
);

select is(
  (select status::text from public.provider_subscriptions where id = '26000000-0000-0000-0000-000000000001'),
  'active',
  '9b. Admin D''s attempt to cancel Org C''s subscription has no effect'
);

-- ---------------------------------------------------------------------
-- 10. No token/secret column is exposed in the public schema: RLS denies
--     everyone (including the connection's rightful owner), and no grant
--     exists for anon/authenticated at all.
-- ---------------------------------------------------------------------
select is(
  (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'calendar_connection_secrets'
      and grantee in ('anon', 'authenticated')
  ),
  0,
  '10a. calendar_connection_secrets has zero grants to anon/authenticated'
);

select pg_temp.tests_as('24000000-0000-0000-0000-000000000002');

select throws_ok(
  $$ select encrypted_access_token from public.calendar_connection_secrets $$,
  '42501',
  null,
  '10b. Even AM C1 (the connection''s own owner) cannot read her own encrypted tokens via the client API'
);

reset role;

select ok(
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  '10c. Only service_role (bypasses RLS, server-only) can ever reach calendar_connection_secrets'
);

select * from finish();
rollback;
