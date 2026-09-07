-- M6 meeting_bot_jobs / meeting_lifecycle_events test matrix. Self-
-- contained fixtures, rolled back at the end, independent of seed data or
-- other pgTAP files.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, Org P has a real manager->AM reporting chain (for
-- meeting_bot_jobs_select_meeting_visible, which reuses meetings' own
-- RLS — including meetings_select_manager_scope from M5).
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('18000000-0000-0000-0000-00000000000a', 'M6 Test Org P', 'm6-test-org-p'),
  ('18000000-0000-0000-0000-00000000000b', 'M6 Test Org Q', 'm6-test-org-q');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '32000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'admin-p@pgtap.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '32000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-00000000000a', 'manager-p@pgtap.test', 'Manager P', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '32000000-0000-0000-0000-000000000003', '18000000-0000-0000-0000-00000000000a', 'am-p1@pgtap.test', 'AM P1', id, '32000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '32000000-0000-0000-0000-000000000004', '18000000-0000-0000-0000-00000000000a', 'am-p2@pgtap.test', 'AM P2', id, '32000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '32000000-0000-0000-0000-000000000005', '18000000-0000-0000-0000-00000000000b', 'admin-q@pgtap.test', 'Admin Q', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager-p@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-p2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'admin-q@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', '32000000-0000-0000-0000-000000000003', 'microsoft', 'ical-bot-p1', 'AM P1 Bot Meeting', 'teams', 'https://meet.example/p1', now() + interval '1 hour', now() + interval '2 hours', 'record');

insert into public.meeting_bot_jobs (id, meeting_id, organization_id, status, generation, idempotency_key) values
  ('35000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'scheduled', 1, '34000000-0000-0000-0000-000000000001:1');

insert into public.meeting_lifecycle_events (id, meeting_id, bot_job_id, organization_id, event_type, source) values
  ('36000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000001', '35000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'bot.scheduled', 'worker');

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
-- 1. Anon denied everywhere.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.meeting_bot_jobs $$, '42501', null, '1a. Anon cannot select meeting_bot_jobs');
select throws_ok($$ select count(*) from public.meeting_lifecycle_events $$, '42501', null, '1b. Anon cannot select meeting_lifecycle_events');

-- ---------------------------------------------------------------------
-- 2. meeting_bot_jobs visibility mirrors meetings' own RLS.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('33000000-0000-0000-0000-000000000003'); -- AM P1, owns the meeting

select is(
  (select status::text from public.meeting_bot_jobs where id = '35000000-0000-0000-0000-000000000001'),
  'scheduled',
  '2a. The meeting owner can see their own meeting''s bot job'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000004'); -- AM P2, sibling, doesn't own this meeting

select is(
  (select count(*)::int from public.meeting_bot_jobs where id = '35000000-0000-0000-0000-000000000001'),
  0,
  '2b. A sibling AM who doesn''t own the meeting cannot see its bot job'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000002'); -- Manager P, in AM P1's reporting tree

select is(
  (select status::text from public.meeting_bot_jobs where id = '35000000-0000-0000-0000-000000000001'),
  'scheduled',
  '2c. An in-tree manager can see the bot job (via meetings_select_manager_scope)'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select status::text from public.meeting_bot_jobs where id = '35000000-0000-0000-0000-000000000001'),
  'scheduled',
  '2d. Org admin can see the bot job org-wide'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000005'); -- Admin Q, cross-org

select is(
  (select count(*)::int from public.meeting_bot_jobs where id = '35000000-0000-0000-0000-000000000001'),
  0,
  '2e. Cross-org admin cannot see the bot job'
);

-- ---------------------------------------------------------------------
-- 3. meeting_lifecycle_events: admin-only, narrower than meeting_bot_jobs.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('33000000-0000-0000-0000-000000000003'); -- AM P1, owns the meeting but isn't admin

select is(
  (select count(*)::int from public.meeting_lifecycle_events where id = '36000000-0000-0000-0000-000000000001'),
  0,
  '3a. The meeting owner (non-admin) cannot see the technical lifecycle log'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select event_type from public.meeting_lifecycle_events where id = '36000000-0000-0000-0000-000000000001'),
  'bot.scheduled',
  '3b. Org admin can see the technical lifecycle log'
);

select pg_temp.tests_as('33000000-0000-0000-0000-000000000005'); -- Admin Q, cross-org

select is(
  (select count(*)::int from public.meeting_lifecycle_events where id = '36000000-0000-0000-0000-000000000001'),
  0,
  '3c. Cross-org admin cannot see another org''s lifecycle log'
);

-- ---------------------------------------------------------------------
-- 4. No authenticated write path at all — worker/service-role only.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('33000000-0000-0000-0000-000000000001'); -- Admin P — even an admin cannot write directly

select throws_ok(
  $$ update public.meeting_bot_jobs set status = 'cancelled' where id = '35000000-0000-0000-0000-000000000001' $$,
  '42501', null, '4a. No authenticated role can update meeting_bot_jobs directly (no grant at all)'
);

select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'pending', 2, 'forged') $$,
  '42501', null, '4b. No authenticated role can insert meeting_bot_jobs directly (no grant at all)'
);

-- ---------------------------------------------------------------------
-- 5. The actual duplicate-bot guarantees — DB constraints, not app logic.
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'pending', 1, 'different-key') $$,
  '23505', null, '5a. (meeting_id, generation) must be unique — a second generation-1 row for the same meeting is rejected'
);

select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'pending', 2, '34000000-0000-0000-0000-000000000001:1') $$,
  '23505', null, '5b. idempotency_key must be globally unique — reusing generation 1''s key is rejected'
);

select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'pending', 2, '34000000-0000-0000-0000-000000000001:2') $$,
  '23505', null, '5c. THE core guarantee: a second LIVE generation for the same meeting is rejected while generation 1 is still scheduled — never two active bots'
);

-- Generation 1 is now cancelled — a fresh generation 2 attempt is allowed
-- (a real re-eligibility scenario: exception rejected after approval, or
-- the meeting got a fresh Teams URL on reschedule).
update public.meeting_bot_jobs set status = 'cancelled', cancelled_at = now() where id = '35000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-00000000000a', 'pending', 2, '34000000-0000-0000-0000-000000000001:2') $$,
  '5d. A fresh generation is allowed once the prior generation is terminal (cancelled)'
);

-- provider_bot_id uniqueness, isolated from the live-per-meeting index —
-- a different meeting reusing the same provider bot id must be rejected.
insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('34000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-00000000000a', '32000000-0000-0000-0000-000000000004', 'microsoft', 'ical-bot-p2', 'AM P2 Bot Meeting', 'teams', 'https://meet.example/p2', now() + interval '1 hour', now() + interval '2 hours', 'record');

update public.meeting_bot_jobs set provider_bot_id = 'vexa-bot-unique-1' where meeting_id = '34000000-0000-0000-0000-000000000001' and generation = 2;

select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key, provider_bot_id) values ('34000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-00000000000a', 'pending', 1, '34000000-0000-0000-0000-000000000002:1', 'vexa-bot-unique-1') $$,
  '23505', null, '5f. provider_bot_id must be unique across all bot jobs, not just within one meeting'
);

-- ---------------------------------------------------------------------
-- 6. organization_id must match the referenced meeting's real org — a DB
-- fact (trigger), added after Codex's M6 final review, not just an
-- app-layer promise. Meeting 34...0002 is in Org P; Org Q is a different
-- organization entirely.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.meeting_bot_jobs (meeting_id, organization_id, status, generation, idempotency_key) values ('34000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-00000000000b', 'pending', 2, 'mismatched-org-key') $$,
  'P0001', null, '6a. meeting_bot_jobs.organization_id must match the referenced meeting''s real organization_id'
);

select throws_ok(
  $$ insert into public.meeting_lifecycle_events (meeting_id, organization_id, event_type, source) values ('34000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-00000000000b', 'bot.scheduled', 'worker') $$,
  'P0001', null, '6b. meeting_lifecycle_events.organization_id must match the referenced meeting''s real organization_id'
);

select * from finish();
rollback;
