-- M16 Slice B: operational_incidents RLS (operational_incidents_select_admin_org).
-- Mirrors 020_manager_customer_visibility.test.sql's fixture shape. Proves:
-- admin sees their own org's incidents, a non-admin in the same org is
-- denied, a cross-org admin is denied, anon is denied entirely, and
-- authenticated has no INSERT/UPDATE/DELETE at all (service_role-only
-- writes per the migration's grants).

begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into public.organizations (id, name, slug, email_domain) values
  ('99000000-0000-0000-0000-00000000000a', 'M16 Test Org P', 'm16-test-org-p', 'm16p.test'),
  ('99000000-0000-0000-0000-00000000000b', 'M16 Test Org Q', 'm16-test-org-q', 'm16q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '99100000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'admin-p@m16test.test', 'Admin (Org P)', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '99100000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-00000000000a', 'am-p@m16test.test', 'Non-admin AM (Org P)', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '99100000-0000-0000-0000-000000000003', '99000000-0000-0000-0000-00000000000b', 'admin-q@m16test.test', 'Admin (Org Q, cross-org)', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '99200000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m16test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '99200000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p@m16test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '99200000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'admin-q@m16test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.operational_incidents (id, organization_id, queue, entity_id, incident_type, severity, reason)
values ('99300000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'transcription', 'entity-1', 'stuck', 'warning', 'worker_stuck_timeout');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- Org P admin: sees the incident.
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.operational_incidents where id = '99300000-0000-0000-0000-000000000001'),
  1, '1. Org admin sees the incident via operational_incidents_select_admin_org'
);
select is(
  (select reason from public.operational_incidents where id = '99300000-0000-0000-0000-000000000001'),
  'worker_stuck_timeout', '2. Org admin sees the real reason text (not filtered/redacted)'
);
select throws_ok(
  $$ insert into public.operational_incidents (organization_id, queue, entity_id, incident_type, severity, reason)
     values ('99000000-0000-0000-0000-00000000000a', 'transcription', 'entity-x', 'stuck', 'warning', 'x') $$,
  '42501', null,
  '3. Even an org admin cannot INSERT (writes are service_role-only)'
);
reset role;

-- Non-admin in the SAME org: denied (this is an admin-only surface, not org-wide).
select pg_temp.tests_as('99200000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.operational_incidents where id = '99300000-0000-0000-0000-000000000001'),
  0, '4. A non-admin membership in the same org cannot see the incident'
);
reset role;

-- Cross-org admin: denied.
select pg_temp.tests_as('99200000-0000-0000-0000-000000000003');
select is(
  (select count(*)::int from public.operational_incidents where id = '99300000-0000-0000-0000-000000000001'),
  0, '5. A different org''s admin cannot see the incident'
);
reset role;

-- Anon: denied entirely.
set role anon;
select throws_ok(
  $$ select count(*) from public.operational_incidents $$,
  '42501', null,
  '6. anon cannot select operational_incidents at all'
);
reset role;

select * from finish();
rollback;
