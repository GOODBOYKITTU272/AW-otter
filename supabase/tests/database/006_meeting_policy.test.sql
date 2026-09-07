-- M5 policy engine + recording exception workflow test matrix.
-- Self-contained fixtures, rolled back at the end, independent of seed
-- data or other pgTAP files.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs. Org P has a real reporting chain (Manager P ->
-- AM P1, AM P2) plus an AM with a (deliberately unusual) direct report,
-- to prove role — not just tree position — gates approval. Org Q exists
-- purely for cross-org isolation checks.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug) values
  ('15000000-0000-0000-0000-00000000000a', 'M5 Test Org P', 'm5-test-org-p'),
  ('15000000-0000-0000-0000-00000000000b', 'M5 Test Org Q', 'm5-test-org-q');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '2b000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', 'admin-p@pgtap.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '2b000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-00000000000a', 'manager-p@pgtap.test', 'Manager P', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '2b000000-0000-0000-0000-000000000003', '15000000-0000-0000-0000-00000000000a', 'am-p1@pgtap.test', 'AM P1', id, '2b000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '2b000000-0000-0000-0000-000000000004', '15000000-0000-0000-0000-00000000000a', 'am-p2@pgtap.test', 'AM P2', id, '2b000000-0000-0000-0000-000000000002', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

-- AM P1 has a direct report (unusual, but the schema doesn't forbid it) —
-- proves role (no exceptions.approve permission), not tree position,
-- is what actually gates approval.
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '2b000000-0000-0000-0000-000000000005', '15000000-0000-0000-0000-00000000000a', 'am-p3@pgtap.test', 'AM P3', id, '2b000000-0000-0000-0000-000000000003', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '2b000000-0000-0000-0000-000000000006', '15000000-0000-0000-0000-00000000000b', 'admin-q@pgtap.test', 'Admin Q', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '2b000000-0000-0000-0000-000000000007', '15000000-0000-0000-0000-00000000000b', 'manager-q@pgtap.test', 'Manager Q', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '2b000000-0000-0000-0000-000000000008', '15000000-0000-0000-0000-00000000000b', 'am-q1@pgtap.test', 'AM Q1', id, '2b000000-0000-0000-0000-000000000007', 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager-p@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-p2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'am-p3@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '2c000000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'admin-q@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end) values
  ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'microsoft', 'ical-am-p1', 'AM P1 Meeting', 'teams', 'https://meet.example/p1', now() + interval '1 hour', now() + interval '2 hours'),
  ('2d000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-00000000000b', '2b000000-0000-0000-0000-000000000008', 'microsoft', 'ical-am-q1', 'AM Q1 Meeting', 'teams', 'https://meet.example/q1', now() + interval '1 hour', now() + interval '2 hours');

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
-- 1. Bootstrap trigger: creating an organization auto-creates its policy
-- set and all nine fixed rule_types.
-- ---------------------------------------------------------------------
reset role;

select is(
  (select count(*)::int from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000a'),
  1,
  '1a. Org P got exactly one auto-created policy set'
);

select is(
  (select count(*)::int from public.meeting_policy_rules mr join public.meeting_policy_sets ps on ps.id = mr.policy_set_id where ps.organization_id = '15000000-0000-0000-0000-00000000000a'),
  9,
  '1b. Org P got all nine fixed rule_types seeded'
);

-- ---------------------------------------------------------------------
-- 2. Anon cannot access any M5 table.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.meeting_policy_sets $$, '42501', null, '2a. Anon cannot select meeting_policy_sets');
select throws_ok($$ select count(*) from public.meeting_policy_rules $$, '42501', null, '2b. Anon cannot select meeting_policy_rules');
select throws_ok($$ select count(*) from public.meeting_policy_decisions $$, '42501', null, '2c. Anon cannot select meeting_policy_decisions');
select throws_ok($$ select count(*) from public.recording_exemption_requests $$, '42501', null, '2d. Anon cannot select recording_exemption_requests');
select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason) values ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'anon') $$,
  '42501', null, '2e. Anon cannot insert recording_exemption_requests'
);

-- ---------------------------------------------------------------------
-- 3. meeting_policy_sets / meeting_policy_rules: readable by any org
-- member, writable only by policy.manage (admin).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('2c000000-0000-0000-0000-000000000003'); -- AM P1, non-admin

select is(
  (select count(*)::int from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000a'),
  1,
  '3a. Any authenticated org member can read the policy set'
);

-- RLS-only denial: the row is granted at the table level but excluded by
-- USING, so the UPDATE affects zero rows rather than raising an error.
update public.meeting_policy_sets set default_decision = 'exclude' where organization_id = '15000000-0000-0000-0000-00000000000a';

select is(
  (select default_decision::text from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000a'),
  'record',
  '3b. Non-admin cannot update the policy set (write silently affects zero rows)'
);

update public.meeting_policy_rules set enabled = false where rule_type = 'org_default';

select is(
  (select enabled from public.meeting_policy_rules where rule_type = 'org_default' and policy_set_id = (select id from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000a')),
  true,
  '3c. Non-admin cannot update a policy rule (write silently affects zero rows)'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000001'); -- Admin P

select lives_ok(
  $$ update public.meeting_policy_rules set enabled = true where rule_type = 'sensitive_internal' and policy_set_id = (select id from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000a') $$,
  '3d. Admin (policy.manage) can update a policy rule'
);

select is(
  (select count(*)::int from public.meeting_policy_sets where organization_id = '15000000-0000-0000-0000-00000000000b'),
  0,
  '3e. Admin P cannot see Org Q''s policy set'
);

-- ---------------------------------------------------------------------
-- 4. meeting_policy_decisions: admin-only read.
-- ---------------------------------------------------------------------
reset role;
insert into public.meeting_policy_decisions (meeting_id, organization_id, decision, rule_type, reason_code) values
  ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', 'record', 'org_default', 'org default applied');

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000003'); -- AM P1, non-admin, even though it's THEIR OWN meeting

select is(
  (select count(*)::int from public.meeting_policy_decisions where meeting_id = '2d000000-0000-0000-0000-000000000001'),
  0,
  '4a. Non-admin cannot read meeting_policy_decisions, even for their own meeting'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select count(*)::int from public.meeting_policy_decisions where meeting_id = '2d000000-0000-0000-0000-000000000001'),
  1,
  '4b. Org admin can read meeting_policy_decisions for their own org'
);

-- ---------------------------------------------------------------------
-- 5. meetings_select_manager_scope: the new, narrow RLS extension.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('2c000000-0000-0000-0000-000000000002'); -- Manager P

select is(
  (select title from public.meetings where id = '2d000000-0000-0000-0000-000000000001'),
  'AM P1 Meeting',
  '5a. Manager can see a direct report''s meeting'
);

select is(
  (select count(*)::int from public.meetings where id = '2d000000-0000-0000-0000-000000000002'),
  0,
  '5b. Manager cannot see another organization''s meeting'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000004'); -- AM P2, no exceptions.approve, no reporting relationship to AM P1

select is(
  (select count(*)::int from public.meetings where id = '2d000000-0000-0000-0000-000000000001'),
  0,
  '5c. A sibling AM cannot see another AM''s meeting via the manager-scope policy'
);

-- ---------------------------------------------------------------------
-- 6-9. recording_exemption_requests: insert (AM, own meeting only, real
-- reason), select/update scoping (own / admin / manager-in-tree / role
-- gate), and the DB-enforced state-transition trigger.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('2c000000-0000-0000-0000-000000000003'); -- AM P1, owns meeting 2d...001

select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason) values ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', '') $$,
  '23514', null, '6a. Empty reason is rejected at the database level'
);

select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason) values ('2d000000-0000-0000-0000-000000000002', '15000000-0000-0000-0000-00000000000b', '2b000000-0000-0000-0000-000000000003', 'not my meeting') $$,
  '42501', null, '6b. AM cannot request for a meeting they do not own'
);

select lives_ok(
  $$ insert into public.recording_exemption_requests (id, meeting_id, organization_id, requested_by, reason) values ('2e000000-0000-0000-0000-000000000001', '2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'Customer requested no recording.') $$,
  '7a. AM can request for their own meeting with a real reason'
);

select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason) values ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'second request') $$,
  '23505', null, '7b. A second pending request for the same meeting is rejected (one live request at a time)'
);

select is(
  (select status::text from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  'requested',
  '7c. AM can read their own request status'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000004'); -- AM P2, not the requester, not a manager

select is(
  (select count(*)::int from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  0,
  '8a. A different AM cannot see someone else''s request'
);

update public.recording_exemption_requests set status = 'approved', reviewed_by = '2b000000-0000-0000-0000-000000000004' where id = '2e000000-0000-0000-0000-000000000001';

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000001'); -- Admin P, authorized to read, checking the write had no effect

select is(
  (select status::text from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  'requested',
  '8b. A different AM cannot approve a request (write silently affects zero rows)'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000005'); -- AM P3, technically reports to AM P1 but has no exceptions.approve permission at all

update public.recording_exemption_requests set status = 'approved', reviewed_by = '2b000000-0000-0000-0000-000000000005' where id = '2e000000-0000-0000-0000-000000000001';

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000001'); -- Admin P again, checking this write also had no effect

select is(
  (select status::text from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  'requested',
  '8c. An account manager cannot approve even with a reporting relationship — role, not tree position, gates approval'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000006'); -- Admin Q, wrong org entirely

select is(
  (select count(*)::int from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  0,
  '9a. Cross-org admin cannot see the request'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000002'); -- Manager P, in AM P1's reporting tree

select is(
  (select status::text from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  'requested',
  '9b. In-tree manager can see the pending request'
);

select lives_ok(
  $$ update public.recording_exemption_requests set status = 'approved', reviewed_by = '2b000000-0000-0000-0000-000000000002', review_notes = 'confirmed', reviewed_at = now() where id = '2e000000-0000-0000-0000-000000000001' $$,
  '9c. In-tree manager can approve the request'
);

select is(
  (select status::text from public.recording_exemption_requests where id = '2e000000-0000-0000-0000-000000000001'),
  'approved',
  '9d. Status is now approved'
);

select throws_ok(
  $$ update public.recording_exemption_requests set status = 'rejected' where id = '2e000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '10a. An already-decided request cannot be re-reviewed (DB trigger blocks it)'
);

reset role;

select throws_ok(
  $$ update public.recording_exemption_requests set status = 'requested' where id = '2e000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '10b. Not even a superuser/service-role write can un-decide a terminal request — the trigger has no role exception'
);

-- ---------------------------------------------------------------------
-- 11. memberships_select_manager_scope (added after Codex's M5 final
-- review: the manager exceptions queue needs to resolve requester/
-- reviewer display names, which M2's RLS never let a non-admin manager
-- do for anyone but themselves).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('2c000000-0000-0000-0000-000000000002'); -- Manager P

select is(
  (select display_name from public.organization_memberships where id = '2b000000-0000-0000-0000-000000000003'),
  'AM P1',
  '11a. In-tree manager can now resolve a report''s display name'
);

select pg_temp.tests_as('2c000000-0000-0000-0000-000000000004'); -- AM P2, sibling, not a manager

select is(
  (select count(*)::int from public.organization_memberships where id = '2b000000-0000-0000-0000-000000000003'),
  0,
  '11b. A sibling AM (no reporting relationship, not a manager themselves) cannot see AM P1''s row'
);

-- ---------------------------------------------------------------------
-- 12. Trigger-level integrity, added after Codex's M5 final review: a
-- forged INSERT can never skip review, and a decided request's
-- meeting_id can never be retargeted even while status stays unchanged
-- (the original trigger only fired on a status change).
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason, status)
     values ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'forged', 'approved') $$,
  'P0001', null, '12a. A new request cannot be inserted already-approved, even bypassing RLS'
);

select throws_ok(
  $$ insert into public.recording_exemption_requests (meeting_id, organization_id, requested_by, reason, status, reviewed_by)
     values ('2d000000-0000-0000-0000-000000000001', '15000000-0000-0000-0000-00000000000a', '2b000000-0000-0000-0000-000000000003', 'forged', 'requested', '2b000000-0000-0000-0000-000000000002') $$,
  'P0001', null, '12b. A new request cannot already carry a reviewer'
);

select throws_ok(
  $$ update public.recording_exemption_requests set meeting_id = '2d000000-0000-0000-0000-000000000002' where id = '2e000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '12c. An approved request cannot be retargeted onto a different meeting_id, even with status left unchanged'
);

select throws_ok(
  $$ update public.meeting_policy_sets set cutoff_minutes_before_start = -1 where organization_id = '15000000-0000-0000-0000-00000000000a' $$,
  '23514', null, '12d. cutoff_minutes_before_start cannot be negative (DB check constraint)'
);

select * from finish();
rollback;
