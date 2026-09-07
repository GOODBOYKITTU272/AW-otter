-- M4 meetings test matrix, updated for the dedupe redesign
-- (20260906020021/022): meetings identity moved from external_event_id to
-- ical_uid, mailbox-sync identity moved to meeting_external_events, and
-- microsoft_tenant_connections was added. Self-contained fixtures, rolled
-- back at the end and independent of seed data or other pgTAP files.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

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
  id, organization_id, owner_membership_id, provider, ical_uid,
  meeting_url, title, meeting_type, scheduled_start, scheduled_end
) values
  ('27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'ical-own-e1', 'https://meet.example/e1', 'AM E1 Meeting', 'demo', now() + interval '1 hour', now() + interval '2 hours'),
  ('27000000-0000-0000-0000-000000003002', '13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000003', 'microsoft', 'ical-other-e2', 'https://meet.example/e2', 'AM E2 Meeting', 'demo', now() + interval '3 hours', now() + interval '4 hours'),
  ('27000000-0000-0000-0000-000000003101', '13000000-0000-0000-0000-00000000000b', '27000000-0000-0000-0000-000000001001', 'microsoft', 'ical-org-f', 'https://meet.example/f', 'Org F Meeting', 'demo', now() + interval '5 hours', now() + interval '6 hours');

insert into public.meeting_attendees (id, meeting_id, email, display_name, participant_type, invited, attended) values
  ('27000000-0000-0000-0000-000000004001', '27000000-0000-0000-0000-000000003001', 'visible@pgtap.test', 'Visible Attendee', 'required', true, true),
  ('27000000-0000-0000-0000-000000004002', '27000000-0000-0000-0000-000000003002', 'hidden@pgtap.test', 'Hidden Attendee', 'required', true, false);

-- Mailbox-sync mappings: AM E1's own mailbox observed meeting 3001; Admin E
-- (as a fellow observer, e.g. via tenant sync) also observed 3001 through
-- their own mailbox with a DIFFERENT external_event_id — the exact scenario
-- the dedupe redesign exists for. AM E2's mailbox observed 3002. Org F's
-- admin observed the Org F meeting.
insert into public.meeting_external_events (id, meeting_id, organization_id, provider, provider_user_key, external_event_id, is_organizer) values
  ('27000000-0000-0000-0000-000000006001', '27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'am-e1@pgtap.test', 'mailbox-evt-e1-own', true),
  ('27000000-0000-0000-0000-000000006002', '27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'admin-e@pgtap.test', 'mailbox-evt-e1-observed-by-admin', false),
  ('27000000-0000-0000-0000-000000006003', '27000000-0000-0000-0000-000000003002', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'am-e2@pgtap.test', 'mailbox-evt-e2-own', true),
  ('27000000-0000-0000-0000-000000006101', '27000000-0000-0000-0000-000000003101', '13000000-0000-0000-0000-00000000000b', 'microsoft', 'admin-f@pgtap.test', 'mailbox-evt-f-own', true);

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
select throws_ok($$ insert into public.meetings (organization_id, owner_membership_id, provider, ical_uid, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'anon-insert', 'Anon Insert', now(), now() + interval '1 hour') $$, '42501', null, '1b. Anon cannot insert meetings');
select throws_ok($$ update public.meetings set title = 'Anon Update' where id = '27000000-0000-0000-0000-000000003001' $$, '42501', null, '1c. Anon cannot update meetings');
select throws_ok($$ delete from public.meetings where id = '27000000-0000-0000-0000-000000003001' $$, '42501', null, '1d. Anon cannot delete meetings');

select throws_ok($$ select count(*) from public.meeting_attendees $$, '42501', null, '1e. Anon cannot select meeting_attendees');
select throws_ok($$ insert into public.meeting_attendees (meeting_id, email) values ('27000000-0000-0000-0000-000000003001', 'anon-attendee@pgtap.test') $$, '42501', null, '1f. Anon cannot insert meeting_attendees');
select throws_ok($$ update public.meeting_attendees set display_name = 'Anon Update' where id = '27000000-0000-0000-0000-000000004001' $$, '42501', null, '1g. Anon cannot update meeting_attendees');
select throws_ok($$ delete from public.meeting_attendees where id = '27000000-0000-0000-0000-000000004001' $$, '42501', null, '1h. Anon cannot delete meeting_attendees');

select throws_ok($$ select count(*) from public.calendar_event_jobs $$, '42501', null, '1i. Anon cannot select calendar_event_jobs');
select throws_ok($$ insert into public.calendar_event_jobs (calendar_connection_id, organization_id, provider, external_event_id, change_type, provider_user_key) values ('27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'anon-job', 'updated', 'am-e1@pgtap.test') $$, '42501', null, '1j. Anon cannot insert calendar_event_jobs');
select throws_ok($$ update public.calendar_event_jobs set status = 'processing' $$, '42501', null, '1k. Anon cannot update calendar_event_jobs');
select throws_ok($$ delete from public.calendar_event_jobs $$, '42501', null, '1l. Anon cannot delete calendar_event_jobs');

select throws_ok($$ select count(*) from public.meeting_external_events $$, '42501', null, '1m. Anon cannot select meeting_external_events');
select throws_ok($$ select count(*) from public.microsoft_tenant_connections $$, '42501', null, '1n. Anon cannot select microsoft_tenant_connections');

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
  $$ insert into public.meetings (organization_id, owner_membership_id, provider, ical_uid, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'auth-insert', 'Auth Insert', now(), now() + interval '1 hour') $$,
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

select is(
  (select count(*)::int from public.calendar_event_jobs),
  0,
  '8a. Non-admin authenticated user sees no calendar_event_jobs rows'
);
select throws_ok($$ insert into public.calendar_event_jobs (calendar_connection_id, organization_id, provider, external_event_id, change_type, provider_user_key) values ('27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'auth-job', 'updated', 'am-e1@pgtap.test') $$, '42501', null, '8b. Authenticated user cannot insert calendar_event_jobs');
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

select is(
  (
    select array_agg(privilege_type::text order by privilege_type)::text[]
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'meeting_external_events'
      and grantee = 'service_role'
  ),
  array['DELETE', 'INSERT', 'SELECT', 'UPDATE']::text[],
  '9d. service_role has the intended meeting_external_events grants'
);

select is(
  (
    select array_agg(privilege_type::text order by privilege_type)::text[]
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'microsoft_tenant_connections'
      and grantee = 'service_role'
  ),
  array['SELECT', 'UPDATE']::text[],
  '9e. service_role has the intended microsoft_tenant_connections grants (read + last_reconciliation_result only, never enables/disables)'
);

select lives_ok(
  $$ update public.meetings set lifecycle_status = 'completed' where id = '27000000-0000-0000-0000-000000003001' $$,
  '9f. RLS-bypass context can update meetings'
);

select lives_ok(
  $$ update public.meeting_attendees set attended = false where id = '27000000-0000-0000-0000-000000004001' $$,
  '9g. RLS-bypass context can update meeting_attendees'
);

select lives_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, provider_user_key) values ('27000000-0000-0000-0000-000000005001', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'service-job', 'updated', 'completed', 'am-e1@pgtap.test') $$,
  '9h. RLS-bypass context can insert calendar_event_jobs'
);

-- ---------------------------------------------------------------------
-- 10-11. calendar_event_jobs pending/processing dedupe.
-- ---------------------------------------------------------------------
insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, provider_user_key) values
  ('27000000-0000-0000-0000-000000005002', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending', 'am-e1@pgtap.test');

select throws_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, provider_user_key) values ('27000000-0000-0000-0000-000000005003', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending', 'am-e1@pgtap.test') $$,
  '23505',
  null,
  '10. Duplicate pending calendar_event_jobs are rejected'
);

update public.calendar_event_jobs
set status = 'completed'
where id = '27000000-0000-0000-0000-000000005002';

select lives_ok(
  $$ insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, provider_user_key) values ('27000000-0000-0000-0000-000000005004', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'dedupe-event', 'updated', 'pending', 'am-e1@pgtap.test') $$,
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

insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, run_at, provider_user_key) values
  ('27000000-0000-0000-0000-000000005101', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-earlier', 'updated', 'pending', now() - interval '2 minutes', 'am-e1@pgtap.test'),
  ('27000000-0000-0000-0000-000000005102', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-later', 'updated', 'pending', now() - interval '1 minute', 'am-e1@pgtap.test'),
  ('27000000-0000-0000-0000-000000005103', '27000000-0000-0000-0000-000000002001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'claim-future', 'updated', 'pending', now() + interval '1 day', 'am-e1@pgtap.test');

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
-- 14. meetings uniqueness — now on (organization_id, provider, ical_uid),
-- not external_event_id (removed from this table entirely).
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.meetings (organization_id, owner_membership_id, provider, ical_uid, title, scheduled_start, scheduled_end) values ('13000000-0000-0000-0000-00000000000a', '27000000-0000-0000-0000-000000000002', 'microsoft', 'ical-own-e1', 'Duplicate Meeting', now(), now() + interval '1 hour') $$,
  '23505',
  null,
  '14. Duplicate meetings for the same org/provider/ical_uid are rejected'
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

-- ---------------------------------------------------------------------
-- 16. calendar_event_jobs admin visibility, including the mismatched-org
-- edge case Codex's review flagged.
-- ---------------------------------------------------------------------
reset role;

insert into public.calendar_connections (id, organization_membership_id, provider, provider_user_id, status, scope_metadata) values
  ('27000000-0000-0000-0000-000000002101', '27000000-0000-0000-0000-000000001001', 'microsoft', 'ms-oid-f1', 'active', '{"email":"admin-f@applywizz.example"}');

-- Deliberately mismatched: organization_id column says Org E, but the
-- connection it's actually enqueued against belongs to Org F. Proves
-- visibility is derived from the real connection -> membership -> org
-- chain, not the denormalized organization_id column on the job row.
insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, provider, external_event_id, change_type, status, provider_user_key) values
  ('27000000-0000-0000-0000-000000005201', '27000000-0000-0000-0000-000000002101', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'mismatched-org-event', 'created', 'pending', 'admin-f@pgtap.test');

select pg_temp.tests_as('28000000-0000-0000-0000-000000000001'); -- Admin E

select cmp_ok(
  (select count(*)::int from public.calendar_event_jobs where organization_id = '13000000-0000-0000-0000-00000000000a'),
  '>',
  0,
  '16a. Org admin can select their own organization''s calendar_event_jobs'
);

select is(
  (select count(*)::int from public.calendar_event_jobs where id = '27000000-0000-0000-0000-000000005201'),
  0,
  '16b. Org E admin cannot see a job whose organization_id column says Org E but whose real connection belongs to Org F'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000001001'); -- Admin F

select is(
  (select count(*)::int from public.calendar_event_jobs where id = '27000000-0000-0000-0000-000000005001'),
  0,
  '16c. Org admin cannot select another organization''s (real, connection-owned) calendar_event_jobs'
);

select is(
  (select count(*)::int from public.calendar_event_jobs where id = '27000000-0000-0000-0000-000000005201'),
  1,
  '16d. Org F admin CAN see the mismatched job, because it is really enqueued against their own connection'
);

-- ---------------------------------------------------------------------
-- 17. meeting_external_events: admin-org-scoped select only (no "select
-- own" for regular employees — same shape as calendar_event_jobs, not
-- calendar_connections), and its lookup-uniqueness constraint.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('28000000-0000-0000-0000-000000000002'); -- AM E1, non-admin

select is(
  (select count(*)::int from public.meeting_external_events),
  0,
  '17a. Non-admin authenticated user sees no meeting_external_events rows, even for their own meeting'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000000001'); -- Admin E

select is(
  (select count(*)::int from public.meeting_external_events mee join public.meetings m on m.id = mee.meeting_id where m.organization_id = '13000000-0000-0000-0000-00000000000a'),
  3,
  '17b. Org admin can select every mailbox mapping for meetings in their own organization'
);

select is(
  (select count(*)::int from public.meeting_external_events where id = '27000000-0000-0000-0000-000000006101'),
  0,
  '17c. Org admin cannot select another organization''s meeting_external_events mapping'
);

reset role;

select throws_ok(
  $$ insert into public.meeting_external_events (meeting_id, organization_id, provider, provider_user_key, external_event_id, is_organizer) values ('27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'am-e1@pgtap.test', 'mailbox-evt-e1-own', true) $$,
  '23505',
  null,
  '17d. Duplicate (organization_id, provider, provider_user_key, external_event_id) mapping is rejected'
);

-- ---------------------------------------------------------------------
-- 18. microsoft_tenant_connections: admin-only, org-scoped, both read and
-- write — a bigger blast radius than one person's own connection (Codex's
-- review), so unlike calendar_connections there's no "select own" path at
-- all for non-admins.
-- ---------------------------------------------------------------------
-- Non-admin insert attempt happens FIRST, before any row exists for this
-- org — deliberately isolates the RLS with-check denial (42501) from the
-- unique-constraint case tested separately below, so this assertion can't
-- be ambiguous about which one actually fired.
select pg_temp.tests_as('28000000-0000-0000-0000-000000000002'); -- AM E1, non-admin

select throws_ok(
  $$ insert into public.microsoft_tenant_connections (organization_id, provider, connected_by_membership_id) values ('13000000-0000-0000-0000-00000000000a', 'microsoft', '27000000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  '18a. Non-admin authenticated user cannot enable tenant-wide sync'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000000001'); -- Admin E

select lives_ok(
  $$ insert into public.microsoft_tenant_connections (organization_id, provider, connected_by_membership_id) values ('13000000-0000-0000-0000-00000000000a', 'microsoft', '27000000-0000-0000-0000-000000000001') $$,
  '18b. Org admin can enable tenant-wide sync for their own organization'
);

select is(
  (select status::text from public.microsoft_tenant_connections where organization_id = '13000000-0000-0000-0000-00000000000a'),
  'active',
  '18c. Newly enabled tenant connection defaults to active'
);

select throws_ok(
  $$ insert into public.microsoft_tenant_connections (organization_id, provider, connected_by_membership_id) values ('13000000-0000-0000-0000-00000000000b', 'microsoft', '27000000-0000-0000-0000-000000000001') $$,
  '42501',
  null,
  '18d. Org admin cannot enable tenant-wide sync for another organization'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000000002'); -- AM E1, non-admin

select is(
  (select count(*)::int from public.microsoft_tenant_connections where organization_id = '13000000-0000-0000-0000-00000000000a'),
  0,
  '18e. Non-admin authenticated user cannot see their own organization''s tenant connection'
);

select pg_temp.tests_as('28000000-0000-0000-0000-000000001001'); -- Admin F

select is(
  (select count(*)::int from public.microsoft_tenant_connections where organization_id = '13000000-0000-0000-0000-00000000000a'),
  0,
  '18f. Org admin cannot see another organization''s tenant connection'
);

reset role;

select throws_ok(
  $$ insert into public.microsoft_tenant_connections (organization_id, provider) values ('13000000-0000-0000-0000-00000000000a', 'microsoft') $$,
  '23505',
  null,
  '18g. Only one tenant connection per (organization_id, provider) is allowed'
);

-- ---------------------------------------------------------------------
-- 19. Ownership race regression (Codex final review, Finding #1 fix).
-- Proves the real Postgres mechanism the application-layer fix depends
-- on: an upsert whose column list OMITS owner_membership_id never
-- touches that column, even when it hits a real ON CONFLICT DO UPDATE
-- against an existing row — this is exactly what
-- upsertCanonicalMeeting's fixed insert branch relies on to stop a
-- non-organizer's first-sighting from overwriting an organizer's
-- already-correct ownership during a concurrent race.
-- ---------------------------------------------------------------------
insert into public.meetings (
  id, organization_id, owner_membership_id, provider, ical_uid,
  title, scheduled_start, scheduled_end
) values (
  '27000000-0000-0000-0000-000000007001', '13000000-0000-0000-0000-00000000000a',
  '27000000-0000-0000-0000-000000000002', 'microsoft', 'ical-race-fixture',
  'Race Fixture Meeting', now() + interval '1 hour', now() + interval '2 hours'
);

-- Mimics exactly what the fixed insert branch sends for a NON-organizer
-- observation: every meetingFields() column plus organization_id/
-- provider/ical_uid — no owner_membership_id anywhere in the statement.
insert into public.meetings (
  organization_id, provider, ical_uid, title, meeting_url, organizer_name,
  organizer_email, meeting_type, scheduled_start, scheduled_end,
  lifecycle_status, reason_code, graph_event_type, series_master_id, original_start
) values (
  '13000000-0000-0000-0000-00000000000a', 'microsoft', 'ical-race-fixture',
  'Race Fixture Meeting (attendee copy)', null, null, null, null,
  now() + interval '1 hour', now() + interval '2 hours', 'upcoming', null, null, null, null
)
on conflict (organization_id, provider, ical_uid) do update set
  title = excluded.title,
  meeting_url = excluded.meeting_url,
  organizer_name = excluded.organizer_name,
  organizer_email = excluded.organizer_email,
  meeting_type = excluded.meeting_type,
  scheduled_start = excluded.scheduled_start,
  scheduled_end = excluded.scheduled_end,
  lifecycle_status = excluded.lifecycle_status,
  reason_code = excluded.reason_code,
  graph_event_type = excluded.graph_event_type,
  series_master_id = excluded.series_master_id,
  original_start = excluded.original_start;

select is(
  (select owner_membership_id from public.meetings where id = '27000000-0000-0000-0000-000000007001'),
  '27000000-0000-0000-0000-000000000002'::uuid,
  '19a. A conflict-update that omits owner_membership_id from its column list never overwrites existing ownership'
);

select is(
  (select title from public.meetings where id = '27000000-0000-0000-0000-000000007001'),
  'Race Fixture Meeting (attendee copy)',
  '19b. Other fields ARE updated by the same conflict — proves this is a real merge, not a no-op that silently did nothing'
);

-- ---------------------------------------------------------------------
-- 20. meeting_external_events org-scoping (Codex final review, Finding #2
-- fix). The same (provider, provider_user_key, external_event_id) triple
-- is no longer a tenant-wide collision — it's scoped per organization_id,
-- and service-role lookups now filter by it explicitly too (see
-- packages/domain/src/meetings.ts).
-- ---------------------------------------------------------------------
insert into public.meeting_external_events (meeting_id, organization_id, provider, provider_user_key, external_event_id, is_organizer) values
  ('27000000-0000-0000-0000-000000003101', '13000000-0000-0000-0000-00000000000b', 'microsoft', 'shared-mailbox-key@pgtap.test', 'shared-event-id', true);

select lives_ok(
  $$ insert into public.meeting_external_events (meeting_id, organization_id, provider, provider_user_key, external_event_id, is_organizer) values ('27000000-0000-0000-0000-000000003001', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'shared-mailbox-key@pgtap.test', 'shared-event-id', true) $$,
  '20a. The same (provider, provider_user_key, external_event_id) is allowed in a DIFFERENT organization — organization_id is genuinely part of the uniqueness boundary now'
);

select throws_ok(
  $$ insert into public.meeting_external_events (meeting_id, organization_id, provider, provider_user_key, external_event_id, is_organizer) values ('27000000-0000-0000-0000-000000003002', '13000000-0000-0000-0000-00000000000a', 'microsoft', 'shared-mailbox-key@pgtap.test', 'shared-event-id', true) $$,
  '23505',
  null,
  '20b. Within the SAME organization, the triple is still uniquely constrained'
);

select * from finish();
rollback;
