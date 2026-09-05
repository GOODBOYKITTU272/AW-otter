-- M1 critical security test matrix (see docs/product blueprint + the M1
-- brief). Self-contained: builds its own fixtures inside this transaction
-- and rolls back at the end, so it never depends on — or pollutes —
-- supabase/seed.sql or anything created by scripts/seed-local-users.mjs.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('10000000-0000-0000-0000-00000000000a', 'Test Org A', 'test-org-a-rls'),
  ('10000000-0000-0000-0000-00000000000b', 'Test Org B', 'test-org-b-rls');

insert into public.organization_memberships (organization_id, work_email, display_name, role_id, status)
select '10000000-0000-0000-0000-00000000000a', 'admin-a@pgtap.test', 'Admin A', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (organization_id, work_email, display_name, role_id, status)
select '10000000-0000-0000-0000-00000000000a', 'manager-a@pgtap.test', 'Manager A', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (organization_id, work_email, display_name, role_id, status)
select '10000000-0000-0000-0000-00000000000a', 'am-a1@pgtap.test', 'AM A1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (organization_id, work_email, display_name, role_id, status)
select '10000000-0000-0000-0000-00000000000a', 'am-a2@pgtap.test', 'AM A2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (organization_id, work_email, display_name, role_id, status)
select '10000000-0000-0000-0000-00000000000b', 'admin-b@pgtap.test', 'Admin B', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

-- Inserting directly into auth.users fires on_auth_user_created (the same
-- trigger a real first sign-in fires), which links + activates the
-- matching invited membership above by work_email.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'admin-a@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-0000000000a2', 'authenticated', 'authenticated', 'manager-a@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-0000000000a3', 'authenticated', 'authenticated', 'am-a1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-0000000000a4', 'authenticated', 'authenticated', 'am-a2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'admin-b@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

-- Sanity check on the fixture-building trigger itself before trusting any
-- RLS assertion built on top of it.
select is(
  (select status::text from public.organization_memberships where work_email = 'admin-a@pgtap.test'),
  'active',
  'fixture: on_auth_user_created activated Admin A''s invited membership'
);

-- ---------------------------------------------------------------------
-- Helper: switch simulated identity for the rest of the transaction
-- ---------------------------------------------------------------------
-- select tests_as('<uuid>') sets local role + JWT sub in one statement.
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
-- 1. Account Manager A can read their own membership.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('20000000-0000-0000-0000-0000000000a3');

select is(
  (select display_name from public.organization_memberships where user_id = '20000000-0000-0000-0000-0000000000a3'),
  'AM A1',
  '1. AM A1 can read her own membership'
);

-- ---------------------------------------------------------------------
-- 2. AM A1 cannot read AM A2's membership (same org, no admin policy applies).
-- ---------------------------------------------------------------------
select is(
  (select count(*)::int from public.organization_memberships where work_email = 'am-a2@pgtap.test'),
  0,
  '2. AM A1 cannot read AM A2''s membership row'
);

-- ---------------------------------------------------------------------
-- 3. AM A1 cannot read Org B's membership.
-- ---------------------------------------------------------------------
select is(
  (select count(*)::int from public.organization_memberships where work_email = 'admin-b@pgtap.test'),
  0,
  '3. AM A1 cannot read an Org B membership row'
);

select is(
  (select count(*)::int from public.organizations where id = '10000000-0000-0000-0000-00000000000b'),
  0,
  '3b. AM A1 cannot read Org B''s organization row'
);

-- ---------------------------------------------------------------------
-- 4. Manager cannot automatically become Admin.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('20000000-0000-0000-0000-0000000000a2');

select is(
  private.is_org_admin(),
  false,
  '4. Manager A is not an org admin'
);

select is(
  private.has_permission('organization.manage'),
  false,
  '4b. Manager A does not have organization.manage'
);

select is(
  (select count(*)::int from public.organization_memberships where organization_id = '10000000-0000-0000-0000-00000000000a'),
  1,
  '4c. Manager A (non-admin) can only see her own membership row, not the whole org roster'
);

-- ---------------------------------------------------------------------
-- 5. Admin can read appropriate membership rows inside their own organization.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('20000000-0000-0000-0000-0000000000a1');

select is(
  private.is_org_admin(),
  true,
  '5. Admin A is recognized as org admin'
);

select is(
  (select count(*)::int from public.organization_memberships where organization_id = '10000000-0000-0000-0000-00000000000a'),
  4,
  '5b. Admin A can read all 4 memberships in her own organization'
);

-- ---------------------------------------------------------------------
-- 6. Admin cannot read another organization's memberships.
-- ---------------------------------------------------------------------
select is(
  (select count(*)::int from public.organization_memberships where organization_id = '10000000-0000-0000-0000-00000000000b'),
  0,
  '6. Admin A cannot read Org B''s memberships'
);

select is(
  (select count(*)::int from public.organizations where id = '10000000-0000-0000-0000-00000000000b'),
  0,
  '6b. Admin A cannot read Org B''s organization row'
);

-- Admin mutation is org-scoped too: Admin A's UPDATE policy filters out rows
-- outside her own organization_id via USING, so this matches zero rows
-- (no error — just an UPDATE that touches nothing). Verify the row is
-- genuinely untouched using a superuser read afterward, since Admin A's own
-- SELECT policy can't see the Org B row either way.
update public.organization_memberships
set display_name = 'hacked-by-admin-a'
where work_email = 'admin-b@pgtap.test';

reset role;

select is(
  (select display_name from public.organization_memberships where work_email = 'admin-b@pgtap.test'),
  'Admin B',
  '6c. Admin A''s update attempt on an Org B membership row had no effect'
);

-- ---------------------------------------------------------------------
-- 7. Organization A user cannot read Organization B (repeat with Admin B
--    reading Org A, to prove it is not one-directional).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('20000000-0000-0000-0000-0000000000b1');

select is(
  (select count(*)::int from public.organizations where id = '10000000-0000-0000-0000-00000000000a'),
  0,
  '7. Admin B cannot read Org A''s organization row'
);

select is(
  (select count(*)::int from public.organization_memberships where organization_id = '10000000-0000-0000-0000-00000000000a'),
  0,
  '7b. Admin B cannot read Org A''s memberships'
);

select is(
  (select count(*)::int from public.organizations where id = '10000000-0000-0000-0000-00000000000b'),
  1,
  '7c. Admin B can still read her own organization'
);

-- ---------------------------------------------------------------------
-- 8. System-role resolution works correctly.
-- ---------------------------------------------------------------------
select is(
  private.current_role_key(),
  'admin',
  '8. private.current_role_key() resolves to admin for Admin B'
);

select pg_temp.tests_as('20000000-0000-0000-0000-0000000000a3');

select is(
  private.current_role_key(),
  'account_manager',
  '8b. private.current_role_key() resolves to account_manager for AM A1'
);

select is(
  (select count(*)::int from public.roles where organization_id is null),
  4,
  '8c. Exactly the 4 approved system roles are visible'
);

-- ---------------------------------------------------------------------
-- 9. Permission lookup does not grant permissions from another organization.
-- ---------------------------------------------------------------------
select is(
  private.has_permission('meetings.read'),
  true,
  '9. AM A1 has meetings.read (her own role''s permission)'
);

select is(
  private.has_permission('organization.manage'),
  false,
  '9b. AM A1 does not have organization.manage'
);

select pg_temp.tests_as('20000000-0000-0000-0000-0000000000b1');

select is(
  private.has_permission('organization.manage'),
  true,
  '9c. Admin B has organization.manage (her own org''s admin role)'
);

select isnt(
  private.current_organization_id(),
  '10000000-0000-0000-0000-00000000000a'::uuid,
  '9d. Admin B''s resolved organization is never Org A'
);

-- ---------------------------------------------------------------------
-- 10. Unauthenticated access to protected tables is denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

-- No GRANT at all was made to anon (see 20260906020005_row_level_security.sql),
-- so Postgres denies access outright before RLS is even evaluated —
-- a hard permission error, not just an empty result.
select throws_ok(
  $$ select count(*) from public.organizations $$,
  '42501',
  null,
  '10. Unauthenticated (anon) read of organizations is denied'
);

select throws_ok(
  $$ select count(*) from public.organization_memberships $$,
  '42501',
  null,
  '10b. Unauthenticated (anon) read of organization_memberships is denied'
);

select throws_ok(
  $$ select count(*) from public.roles $$,
  '42501',
  null,
  '10c. Unauthenticated (anon) read of roles is denied'
);

select throws_ok(
  $$ insert into public.organizations (name, slug) values ('x', 'y-anon-insert-attempt') $$,
  '42501',
  null,
  '10d. Unauthenticated (anon) insert into organizations is denied'
);

-- ---------------------------------------------------------------------
-- 11. service_role bypasses RLS by design — confirms it is powerful enough
--     that it must stay server-side only (enforced by env/server.ts's
--     browser-import guard, not by anything at the SQL level).
-- ---------------------------------------------------------------------
reset role;

select ok(
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  '11. service_role bypasses RLS (must never be used client-side — see packages/database/src/server.ts)'
);

select ok(
  not (select rolbypassrls from pg_roles where rolname = 'authenticated'),
  '11b. authenticated role does NOT bypass RLS'
);

select ok(
  not (select rolbypassrls from pg_roles where rolname = 'anon'),
  '11c. anon role does NOT bypass RLS'
);

select * from finish();
rollback;
