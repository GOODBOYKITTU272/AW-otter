-- M10 confirm/reject/resolve/assign test matrix. Self-contained fixtures,
-- rolled back at the end. Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs (P, Q). Org P: admin, AM P1 (owns the customer),
-- AM P2 (sibling, no access), Manager P (manages AM P1, has
-- intelligence.read). Org Q: AM Q1 (cross-org). One customer owned by
-- AM P1, one meeting, one completed ai_run, evidence segments, one
-- pre-existing confirmed truth fact (to prove supersede), one proposed
-- truth fact for the SAME field, one proposed fact for a DIFFERENT
-- field (for reject tests), one detected call_record.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, email_domain) values
  ('39000000-0000-0000-0000-00000000000e', 'M10 Test Org P', 'm10-test-org-p', 'm10p.test'),
  ('39000000-0000-0000-0000-00000000000f', 'M10 Test Org Q', 'm10-test-org-q', 'm10q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '80000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', 'admin-p@m10test.test', 'Admin P', id, 'active'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '80000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000e', 'am-p1@m10test.test', 'AM P1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '80000000-0000-0000-0000-000000000003', '39000000-0000-0000-0000-00000000000e', 'am-p2@m10test.test', 'AM P2', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select '80000000-0000-0000-0000-000000000004', '39000000-0000-0000-0000-00000000000e', 'manager-p@m10test.test', 'Manager P', id, null, 'active'
from public.roles where key = 'manager' and organization_id is null;

update public.organization_memberships set manager_membership_id = '80000000-0000-0000-0000-000000000004'
where id = '80000000-0000-0000-0000-000000000002';

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '80000000-0000-0000-0000-000000000005', '39000000-0000-0000-0000-00000000000f', 'am-q1@m10test.test', 'AM Q1', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m10test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@m10test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@m10test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'manager-p@m10test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '81000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'am-q1@m10test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

update public.organization_memberships set user_id = '81000000-0000-0000-0000-000000000001' where id = '80000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = '81000000-0000-0000-0000-000000000002' where id = '80000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = '81000000-0000-0000-0000-000000000003' where id = '80000000-0000-0000-0000-000000000003';
update public.organization_memberships set user_id = '81000000-0000-0000-0000-000000000004' where id = '80000000-0000-0000-0000-000000000004';
update public.organization_memberships set user_id = '81000000-0000-0000-0000-000000000005' where id = '80000000-0000-0000-0000-000000000005';

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('82000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', 'M10 Test Customer', '80000000-0000-0000-0000-000000000002', 'manual');

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status, call_type, customer_id) values
  ('83000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '80000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m10-1', 'M10 Test Meeting', 'teams', 'https://meet.example/m10p1', now() - interval '1 hour', now() - interval '30 minutes', 'record', 'discovery', '82000000-0000-0000-0000-000000000001');

insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status, detected_language) values
  ('84000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '83000000-0000-0000-0000-000000000001', 'completed', 'en');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, original_language, canonical_english_text) values
  ('85000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '84000000-0000-0000-0000-000000000001', 0, 0, 4000, 'I want Python backend roles now.', 'en', 'I want Python backend roles now.');

insert into public.ai_runs (id, organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version, status)
values ('86000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '83000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-000000000001', 'test-model', 'v1', 'v1', 'completed');

insert into public.call_records (id, organization_id, meeting_id, customer_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids, status)
values ('87000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '83000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', '86000000-0000-0000-0000-000000000001', 'action_item', 'Follow up on Python roles', 'am', array['85000000-0000-0000-0000-000000000001']::uuid[], 'detected');

-- Pre-existing confirmed fact for field 'target_roles' (to prove supersede).
insert into public.customer_truth_facts (id, organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
values ('88000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000e', '82000000-0000-0000-0000-000000000001', 'target_roles', '"Java roles"'::jsonb, 'confirmed', 'manual', '80000000-0000-0000-0000-000000000002', now() - interval '1 day');

-- Proposed fact for the SAME field (should supersede the row above on confirm).
insert into public.customer_truth_facts (id, organization_id, customer_id, field_key, value, status, source_type, source_meeting_id, evidence_segment_ids, detected_at)
values ('88000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000e', '82000000-0000-0000-0000-000000000001', 'target_roles', '"Python backend"'::jsonb, 'proposed', 'meeting', '83000000-0000-0000-0000-000000000001', array['85000000-0000-0000-0000-000000000001']::uuid[], now());

-- Proposed fact for a DIFFERENT field (for reject tests — untouched by the confirm above).
insert into public.customer_truth_facts (id, organization_id, customer_id, field_key, value, status, source_type, source_meeting_id, evidence_segment_ids, detected_at)
values ('88000000-0000-0000-0000-000000000003', '39000000-0000-0000-0000-00000000000e', '82000000-0000-0000-0000-000000000001', 'work_mode', '"remote"'::jsonb, 'proposed', 'meeting', '83000000-0000-0000-0000-000000000001', array['85000000-0000-0000-0000-000000000001']::uuid[], now());

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
-- 1. Function privileges: anon cannot execute any of the 4 new RPCs.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok(
  $$ select public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid) $$,
  '42501', null, '1a. Anon cannot execute confirm_customer_truth_fact'
);
select throws_ok(
  $$ select public.reject_customer_truth_fact('88000000-0000-0000-0000-000000000003'::uuid) $$,
  '42501', null, '1b. Anon cannot execute reject_customer_truth_fact'
);
select throws_ok(
  $$ select public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'completed') $$,
  '42501', null, '1c. Anon cannot execute resolve_call_record'
);
select throws_ok(
  $$ select public.assign_call_record_owner('87000000-0000-0000-0000-000000000001'::uuid, '80000000-0000-0000-0000-000000000002'::uuid) $$,
  '42501', null, '1d. Anon cannot execute assign_call_record_owner'
);

-- ---------------------------------------------------------------------
-- 2. Proposed fact cannot become confirmed via a raw table write —
--    authenticated has SELECT/INSERT only on customer_truth_facts, no
--    UPDATE grant at all (the RPC is the only write path for status
--    transitions beyond the M7A manual-seed insert policy).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002'); -- AM P1, owns the customer

select throws_ok(
  $$ update public.customer_truth_facts set status = 'confirmed' where id = '88000000-0000-0000-0000-000000000002' $$,
  '42501', null, '2a. Authenticated cannot directly UPDATE customer_truth_facts (no grant — RPC only)'
);
select throws_ok(
  $$ update public.call_records set status = 'completed' where id = '87000000-0000-0000-0000-000000000001' $$,
  '42501', null, '2b. Authenticated cannot directly UPDATE call_records (no grant — RPC only)'
);

-- ---------------------------------------------------------------------
-- 3. Cross-org and unauthorized-AM confirm attempts are blocked.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('81000000-0000-0000-0000-000000000005'); -- AM Q1, cross-org

select throws_ok(
  $$ select public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid) $$,
  'P0001', null, '3a. Cross-org confirm attempt is blocked (fact not found in Q''s org scope)'
);

select pg_temp.tests_as('81000000-0000-0000-0000-000000000003'); -- AM P2, sibling, doesn't own this customer

select throws_ok(
  $$ select public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid) $$,
  'P0001', null, '3b. An unauthorized sibling AM cannot confirm another AM''s customer''s fact'
);

-- ---------------------------------------------------------------------
-- 4. Manager scope: Manager P (is_manager_of AM P1, has intelligence.read)
--    can see and confirm. Admin can too. Real atomic supersede happens
--    here (Manager P confirms field 'target_roles').
-- ---------------------------------------------------------------------
select pg_temp.tests_as('81000000-0000-0000-0000-000000000004'); -- Manager P

select is(
  (select count(*)::int from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  1,
  '4a. Manager P can SEE the proposed fact via the new manager-scope RLS policy'
);

select is(
  (select status::text from public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid)),
  'confirmed',
  '4b. Manager P (in AM P1''s reporting line, with intelligence.read) can confirm the proposed fact'
);

reset role;

select is(
  (select status::text from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  'confirmed',
  '4c. The proposed fact is now confirmed'
);

select is(
  (select status::text from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000001'),
  'superseded',
  '4d. The PRIOR confirmed fact for the same field was atomically superseded'
);

select is(
  (select previous_fact_id from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  '88000000-0000-0000-0000-000000000001'::uuid,
  '4e. The newly-confirmed fact''s previous_fact_id points at the superseded one'
);

select is(
  (select confirmed_by_membership_id from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  '80000000-0000-0000-0000-000000000004'::uuid,
  '4f. confirmed_by_membership_id records the real actor (Manager P)'
);

select isnt(
  (select confirmed_at from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  null,
  '4g. confirmed_at is set'
);

select is(
  (select evidence_segment_ids from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  array['85000000-0000-0000-0000-000000000001']::uuid[],
  '4h. Evidence linkage is preserved unchanged through confirmation'
);

select is(
  (select count(*)::int from public.audit_events where entity_id = '88000000-0000-0000-0000-000000000002' and action = 'customer_truth.confirmed'),
  1,
  '4i. Exactly one audit_events row was written for the confirmation'
);

-- Only one confirmed row for this field can ever exist (real constraint).
select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type)
     values ('39000000-0000-0000-0000-00000000000e', '82000000-0000-0000-0000-000000000001', 'target_roles', '"x"'::jsonb, 'confirmed', 'manual') $$,
  '23505', null, '4j. customer_truth_facts_one_confirmed_per_field_uq blocks a second confirmed row for the same field'
);

-- ---------------------------------------------------------------------
-- 5. Repeated confirm is safe (idempotent), and cannot confirm a fact
--    that's already resolved a DIFFERENT way (rejected/superseded).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002'); -- AM P1, owner

select is(
  (select status::text from public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid)),
  'confirmed',
  '5a. Repeated confirm of an already-confirmed fact is safe and returns confirmed'
);

reset role;
select is(
  (select count(*)::int from public.audit_events where entity_id = '88000000-0000-0000-0000-000000000002' and action = 'customer_truth.confirmed'),
  1,
  '5b. The idempotent repeat did NOT write a second audit_events row'
);
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002');

select throws_ok(
  $$ select public.confirm_customer_truth_fact('88000000-0000-0000-0000-000000000001'::uuid) $$,
  'P0001', null, '5c. Cannot confirm a fact that is now superseded'
);

-- ---------------------------------------------------------------------
-- 6. Reject: leaves current confirmed truth unchanged, is idempotent,
--    cannot reject a confirmed/superseded fact.
-- ---------------------------------------------------------------------
select is(
  (select status::text from public.reject_customer_truth_fact('88000000-0000-0000-0000-000000000003'::uuid, 'not accurate')),
  'rejected',
  '6a. AM P1 can reject a proposed fact for a different field'
);

select is(
  (select status::text from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000002'),
  'confirmed',
  '6b. Rejecting one field''s proposal leaves the OTHER field''s confirmed truth unchanged'
);

reset role;
select is(
  (select rejection_reason from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000003'),
  'not accurate',
  '6c. rejection_reason is recorded'
);
select isnt(
  (select rejected_at from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000003'),
  null,
  '6d. rejected_at is set'
);
select is(
  (select rejected_by_membership_id from public.customer_truth_facts where id = '88000000-0000-0000-0000-000000000003'),
  '80000000-0000-0000-0000-000000000002'::uuid,
  '6e. rejected_by_membership_id records the real actor'
);
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002');

select is(
  (select status::text from public.reject_customer_truth_fact('88000000-0000-0000-0000-000000000003'::uuid)),
  'rejected',
  '6f. Repeated reject of an already-rejected fact is safe (idempotent)'
);

select throws_ok(
  $$ select public.reject_customer_truth_fact('88000000-0000-0000-0000-000000000002'::uuid) $$,
  'P0001', null, '6g. Cannot reject a fact that is confirmed'
);

select throws_ok(
  $$ select public.reject_customer_truth_fact('88000000-0000-0000-0000-000000000001'::uuid) $$,
  'P0001', null, '6h. Cannot reject a fact that is superseded'
);

-- ---------------------------------------------------------------------
-- 7. No deletion of truth history — all 3 rows still exist.
-- ---------------------------------------------------------------------
reset role;
select is(
  (select count(*)::int from public.customer_truth_facts where id in (
    '88000000-0000-0000-0000-000000000001', '88000000-0000-0000-0000-000000000002', '88000000-0000-0000-0000-000000000003'
  )),
  3,
  '7a. No history was deleted — the superseded, confirmed, and rejected rows all still exist'
);

-- ---------------------------------------------------------------------
-- 8. Actions: visibility, cross-org isolation, valid/invalid lifecycle
--    transitions, completion metadata, idempotency.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002'); -- AM P1, owns the meeting

select is(
  (select count(*)::int from public.call_records where id = '87000000-0000-0000-0000-000000000001'),
  1,
  '8a. AM P1 can see the M9-produced call_record as an operational item'
);

select pg_temp.tests_as('81000000-0000-0000-0000-000000000005'); -- AM Q1, cross-org

select is(
  (select count(*)::int from public.call_records where id = '87000000-0000-0000-0000-000000000001'),
  0,
  '8b. Cross-org AM cannot see the call_record'
);

select throws_ok(
  $$ select public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'completed') $$,
  'P0001', null, '8c. Cross-org resolve attempt is blocked (record not found in Q''s org scope)'
);

select pg_temp.tests_as('81000000-0000-0000-0000-000000000002');

select throws_ok(
  $$ select public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'not_a_real_status') $$,
  'P0001', null, '8d. An invalid p_resolution value is rejected'
);

select is(
  (select status::text from public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'completed', 'Sent the follow-up.')),
  'completed',
  '8e. A valid detected->completed transition succeeds'
);

reset role;
select is(
  (select resolved_by_membership_id from public.call_records where id = '87000000-0000-0000-0000-000000000001'),
  '80000000-0000-0000-0000-000000000002'::uuid,
  '8f. resolved_by_membership_id records the real actor'
);
select is(
  (select resolution_note from public.call_records where id = '87000000-0000-0000-0000-000000000001'),
  'Sent the follow-up.',
  '8g. resolution_note is preserved'
);
select isnt(
  (select completed_at from public.call_records where id = '87000000-0000-0000-0000-000000000001'),
  null,
  '8h. completed_at is set'
);
select pg_temp.tests_as('81000000-0000-0000-0000-000000000002');

select is(
  (select status::text from public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'completed')),
  'completed',
  '8i. Repeated resolve to the SAME terminal state is safe (idempotent)'
);

select throws_ok(
  $$ select public.resolve_call_record('87000000-0000-0000-0000-000000000001'::uuid, 'cancelled') $$,
  'P0001', null, '8j. An invalid transition (completed -> cancelled) is blocked'
);

-- ---------------------------------------------------------------------
-- 9. assign_call_record_owner: same-org validation (BLOCKING fix from
--    Codex plan review), active-membership requirement.
-- ---------------------------------------------------------------------
reset role;
insert into public.call_records (id, organization_id, meeting_id, customer_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids, status)
values ('87000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000e', '83000000-0000-0000-0000-000000000001', '82000000-0000-0000-0000-000000000001', '86000000-0000-0000-0000-000000000001', 'commitment', 'Send revised list', 'am', array['85000000-0000-0000-0000-000000000001']::uuid[], 'detected');

select pg_temp.tests_as('81000000-0000-0000-0000-000000000002');

select throws_ok(
  $$ select public.assign_call_record_owner('87000000-0000-0000-0000-000000000002'::uuid, '80000000-0000-0000-0000-000000000005'::uuid) $$,
  'P0001', null, '9a. Cannot assign a cross-org membership as owner (BLOCKING fix — Codex plan review)'
);

select is(
  (select owner_membership_id from public.assign_call_record_owner('87000000-0000-0000-0000-000000000002'::uuid, '80000000-0000-0000-0000-000000000003'::uuid, now() + interval '3 days')),
  '80000000-0000-0000-0000-000000000003'::uuid,
  '9b. Assigning a real same-org membership as owner succeeds'
);

reset role;
select is(
  (select count(*)::int from public.audit_events where entity_id = '87000000-0000-0000-0000-000000000002' and action = 'call_record.owner_assigned'),
  1,
  '9c. Owner assignment writes an audit_events row'
);

select * from finish();
rollback;
