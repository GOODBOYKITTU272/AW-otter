-- M4 meetings test matrix. Self-contained fixtures, rolled back at the end
-- and independent of seed data or other pgTAP files.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, each with an admin/account managers, meetings,
-- attendees, and one Microsoft connection for queue-job tests.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('13000000-0000-0000-0000-00000000000a', 'M4 Test Org E', 'm4-test-org-e'),
  ('13000000-0000-0000-0000-00000000000b', 'M4 Test Org F', 'm4-test-org-f');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '27000000-0000-0000-0000-000000000001', '13000000-0000-0000-0000-00000000000a', 'admin-e@pgtap.test', 'Admin E', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '27000000-0000-0000-0000-000000000002', '13000000-0000-0000-0000-00000000000a', 'am-e1@pgtap.test', 'AM E1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '27000000-0000-0000-0000-000000000003', '13000000-0000-0000-0000-00000000000a', 'am-e2@pgtap.test', 'AM E2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '27000000-0000-0000-0000-000000001001', '13000000-0000-0000-0000-00000000000b', 'admin-f@pgtap.test', 'Admin F', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '28000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-e@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '28000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-e1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '28000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-e2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '28000000-0000-0000-0000-000000001001', 'authenticated', 'authenticated', 'admin-f@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.calendar_connections (id, organization_membership_id, provider, provider_user_id, status, scope_metadata) values
  ('27000000-0000-0000-0000-000000002001', '27000000-0000-0000-0000-000000000002', 'microsoft', 'ms-oid-e1', 'active', '{"email":"am-e1@applywizz.example"}');

insert into public.meetings (
  id, organization_id, owner_membership_id, provider, external_event_id,
  meeting_url, title, meeting_type, scheduled_start, scheduled_end
) values
  ('27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'event-own-e1', 'https://meet.example/e1', 'AM E1 Meeting', 'demo', now() + interval '1 hour', now() + interval '2 hours'),
  ('27000000-0000-0000-0000-000000003002', '13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000003', 'microsoft', 'event-other-e2', 'https://meet.example/e2', 'AM E2 Meeting', 'demo', now() + interval '3 hours', now() + interval '4 hours'),
  ('27000000-0000-0000-0000-000000003101', '13000000-0000-0000-0000-00000000000b', '27000000-0000-0000-0000-000000001001', 'microsoft', 'event-org-f', 'https://meet.example/f', 'Org F Meeting', 'demo', now() + interval '5 hours', now() + interval '6 hours');

insert into public.meeting_attendees (id, meeting_id, email, display_name, participant_type, invited, attended) values
  ('27000000-0000-0000-0000-000000004001', '27000000-0000-0000-0000-000000003001', 'visible@pgtap.test', 'Visible Attendee', 'required', true, true),
  ('27000000-0000-0000-0000-000000004002', '27000000-0000-0000-0000-000000003002', 'hidden@pgtap.test', 'Hidden Attendee', 'required', true, false);

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
-- 1. Anon cannot access M4 tables.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.meetings $$, '42501', null, '1a. Anon cannot select meetings');
select throws_ok($$ insert into public.meetings (organization_id, owner_membership_id, provider, external_event_id, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'anon-insert', 'Anon Insert', now(), now() + interval '1 hour') $$, '42501', null, '1b. Anon cannot insert meetings');
select throws_ok($$ update public.meetings set title = 'Anon Update' where id = '27000000-0000-0000-0000-000000003001' $$, '42501', null, '1c. Anon cannot update meetings');
select throws_ok($$ delete from public.meetings where id = '27000000-0000-0000-0000-000000003001' $$, '42501', null, '1d. Anon cannot delete meetings');

select throws_ok($$ select count(*) from public.meeting_attendees $$, '42501', null, '1e. Anon cannot select meeting_attendees');
select throws_ok($$ insert into public.meeting_attendees (meeting_id, email) values ('27000000-0000-0000-0000-000000003001', 'anon-attendee@pgtap.test') $$, '42501', null, '1f. Anon cannot insert meeting_attendees');
select throws_ok($$ update public.meeting_attendees set display_name = 'Anon Update' where id = '27000000-0000-0000-0000-000000004001' $$, '42501', null, '1g. Anon cannot update meeting_attendees');
select throws_ok($$ delete from public.meeting_attendees where id = '27000000-0000-0000-0000-000000004001' $$, '42501', null, '1h. Anon cannot delete meeting_attendees');

select throws_ok($$ select count(*) from public.calendar_event_jobs $$, '42501', null, '1i. Anon cannot select calendar_event_jobs');
select throws_ok($$ insert into public.calendar_event_jobs (calendar_connection_id, organization_id, provider, external_event_id, change_type) values ('27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'anon-job', 'updated') $$, '42501', null, '1j. Anon cannot insert calendar_event_jobs');
select throws_ok($$ update public.calendar_event_jobs set status = 'processing' $$, '42501', null, '1k. Anon cannot update calendar_event_jobs');
select throws_ok($$ delete from public.calendar_event_jobs $$, '42501', null, '1l. Anon cannot delete calendar_event_jobs');

-- ---------------------------------------------------------------------
-- 2-6. meetings SELECT visibility.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('28000000-0000-0000-0000-000000000002');

select is(
  (select title from public.meetings where id = '27000000-0000-0000-0000-000000003001'),
  'AM E1 Meeting',
  '2. Authenticated member can select her own meeting'
);

select is(
  (select count(*)::int from public.meetings where id = '27000000-0000-0000-0000-000000003002'),
  0,
  '3. Authenticated member cannot select another member''s meeting in the same org'
);

select is(
  (select count(*)::int from public.meetings where id = '27000000-0000-0000-0000-000000003101'),
  0,
  '4. Authenticated member cannot select another organization''s meeting'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000000001');

select is(
  (select count(*)::int from public.meetings where organization_id = '13000000-0000-0000-0000-00000000000a'),
  2,
  '5. Org admin can select all meetings in her own organization'
);

select is(
  (select count(*)::int from public.meetings where organization_id = '13000000-0000-0000-0000-00000000000b'),
  0,
  '6. Org admin cannot select another organization''s meetings'
);

-- ---------------------------------------------------------------------
-- 7-8. Authenticated users cannot write meetings or touch queue jobs.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('28000000-0000-0000-0000-000000000002');

select throws_ok(
  $$ insert into public.meetings (organization_id, owner_membership_id, provider, external_event_id, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'auth-insert', 'Auth Insert', now(), now() + interval '1 hour') $$,
  '42501',
  null,
  '7a. Authenticated owner cannot insert meetings directly'
);

select throws_ok(
  $$ update public.meetings set title = 'Auth Update' where id = '27000000-0000-0000-0000-000000003001' $$,
  '42501',
  null,
  '7b. Authenticated owner cannot update meetings directly'
);

select throws_ok($$ select count(*) from public.calendar_event_jobs $$, '42501', null, '8a. Authenticated user cannot select calendar_event_jobs');
select throws_ok($$ insert into public.calendar_event_jobs (calendar_connection_id, organization_id, provider, external_event_id, change_type) values ('27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'auth-job', 'updated') $$, '42501', null, '8b. Authenticated user cannot insert calendar_event_jobs');
select throws_ok($$ update public.calendar_event_jobs set status = 'processing' $$, '42501', null, '8c. Authenticated user cannot update calendar_event_jobs');

-- ---------------------------------------------------------------------
-- 9. service_role grants exist, and superuser/RLS-bypass writes work.
-- ---------------------------------------------------------------------
reset role;

select is(
  (
    select array_agg(privilege_type::text order by privilege_type)::text[]
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'meetings'
      and grantee = 'service_role'
  ),
  array['INSERT', 'SELECT', 'UPDATE']::text[],
  '9a. service_role has the intended meetings grants'
);

select is(
  (
    select array_agg(privilege_type::text order by privilege_type)::text[]
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'meeting_attendees'
      and grantee = 'service_role'
  ),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[],
  '9b. service_role has the intended meeting_attendees grants'
);

select is(
  (
    select array_agg(privilege_type::text order by privilege_type)::text[]
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'calendar_event_jobs'
      and grantee = 'service_role'
  ),
  array['INSERT', 'SELECT', 'UPDATE']::text[],
  '9c. service_role has the intended calendar_event_jobs grants'
);

select lives_ok(
  $$ update public.meetings set lifecycle_status = 'completed' where id = '27000000-0000-0000-0000-000000003001' $$,
  '9d. RLS-bypass context can update meetings'
);

select lives_ok(
  $$ update public.meeting_attendees set attended = false where id = '27000000-0000-0000-0000-000000004001' $$,
  '9e. RLS-bypass context can update meeting_attendees'
);

select lives_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status) values ('27000000-0000-0000-0000-000000005001', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'service-job', 'updated', 'completed') $$,
  '9f. RLS-bypass context can insert calendar_event_jobs'
);

-- ---------------------------------------------------------------------
-- 10-11. calendar_event_jobs pending/processing dedupe.
-- ---------------------------------------------------------------------
insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status) values
  ('27000000-0000-0000-0000-000000005002', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending');

select throws_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status) values ('27000000-0000-0000-0000-000000005003', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending') $$,
  '23505',
  null,
  '10. Duplicate pending calendar_event_jobs are rejected'
);

update public.calendar_event_jobs
set status = 'completed'
where id = '27000000-0000-0000-0000-000000005002';

select lives_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status) values ('27000000-0000-0000-0000-000000005004', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending') $$,
  '11a. A new pending job is allowed after the previous one completed'
);

select is(
  (select count(*)::int from public.calendar_event_jobs where external_event_id = 'dedupe-event' and change_type = 'updated'),
  2,
  '11b. Historical completed job and new pending job can coexist'
);

-- ---------------------------------------------------------------------
-- 12-13. claim_next_calendar_event_job claims due jobs once, in run_at order.
-- ---------------------------------------------------------------------
update public.calendar_event_jobs
set status = 'completed'
where status = 'pending';

insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, run_at) values
  ('27000000-0000-0000-0000-000000005101', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-earlier', 'updated', 'pending', now() - interval '2 minutes'),
  ('27000000-0000-0000-0000-000000005102', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-later', 'updated', 'pending', now() - interval '1 minute'),
  ('27000000-0000-0000-0000-000000005103', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-future', 'updated', 'pending', now() + interval '1 day');

select is(
  (select id from public.claim_next_calendar_event_job()),
  '27000000-0000-0000-0000-000000005101'::uuid,
  '12a. claim_next_calendar_event_job returns the earliest due pending job'
);

select is(
  (select status::text from public.calendar_event_jobs where id = '27000000-0000-0000-0000-000000005101'),
  'processing',
  '12b. claim_next_calendar_event_job marks the claimed row processing'
);

select is(
  (select id from public.claim_next_calendar_event_job()),
  '27000000-0000-0000-0000-000000005102'::uuid,
  '12c. claim_next_calendar_event_job skips an already claimed job'
);

select is(
  (select id from public.claim_next_calendar_event_job()),
  null::uuid,
  '13a. claim_next_calendar_event_job returns null when no due pending jobs exist'
);

select is(
  (select status::text from public.calendar_event_jobs where id = '27000000-0000-0000-0000-000000005103'),
  'pending',
  '13b. claim_next_calendar_event_job leaves future-dated jobs pending'
);

-- ---------------------------------------------------------------------
-- 14. meetings uniqueness.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.meetings (organization_id, owner_membership_id, provider, external_event_id, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'event-own-e1', 'Duplicate Meeting', now(), now() + interval '1 hour') $$,
  '23505',
  null,
  '14. Duplicate meetings for the same org/provider/external_event_id are rejected'
);

-- ---------------------------------------------------------------------
-- 15. meeting_attendees visibility follows parent meeting visibility.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('28000000-0000-0000-0000-000000000002');

select is(
  (select count(*)::int from public.meeting_attendees where id = '27000000-0000-0000-0000-000000004002'),
  0,
  '15a. Attendee on an invisible parent meeting is invisible'
);

select is(
  (select email::text from public.meeting_attendees where id = '27000000-0000-0000-0000-000000004001'),
  'visible@pgtap.test',
  '15b. Attendee on a visible parent meeting is visible'
);

select * from finish();
rollback;
