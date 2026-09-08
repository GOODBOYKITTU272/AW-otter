-- M9 ai_runs / call_records / customer_truth materialization test matrix.
-- Self-contained fixtures, rolled back at the end. Run with:
-- supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs (P, Q), an owning AM, a sibling AM, a cross-org AM,
-- an admin, a customer, two meetings (one for the main scenarios, a
-- second one purely to prove the evidence-segment trigger rejects a
-- cross-meeting segment id), completed transcripts+segments for both.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, email_domain) values
  ('39000000-0000-0000-0000-00000000000c', 'M9 Test Org P', 'm9-test-org-p', 'm9p.test'),
  ('39000000-0000-0000-0000-00000000000d', 'M9 Test Org Q', 'm9-test-org-q', 'm9q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '67000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', 'admin-p@m9test.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '67000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000c', 'am-p1@m9test.test', 'AM P1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '67000000-0000-0000-0000-000000000003', '39000000-0000-0000-0000-00000000000c', 'am-p2@m9test.test', 'AM P2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '67000000-0000-0000-0000-000000000004', '39000000-0000-0000-0000-00000000000d', 'am-q1@m9test.test', 'AM Q1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '68000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m9test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '68000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@m9test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '68000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@m9test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '68000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-q1@m9test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('69000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', 'M9 Test Customer', '67000000-0000-0000-0000-000000000002', 'manual');

-- Meeting 1: main scenario meeting. customer_id starts NULL (needs_link)
-- to test deferred customer_truth materialization.
insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status, call_type) values
  ('70000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', '67000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m9-1', 'M9 Test Meeting P1', 'teams', 'https://meet.example/m9p1', now() - interval '1 hour', now() - interval '30 minutes', 'record', 'discovery');

-- Meeting 2: only exists to prove the evidence trigger rejects a segment
-- id that belongs to a DIFFERENT meeting's transcript.
insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('70000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000c', '67000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m9-2', 'M9 Test Meeting P2', 'teams', 'https://meet.example/m9p2', now() - interval '3 hours', now() - interval '2 hours', 'record');

insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status, detected_language) values
  ('71000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', 'completed', 'en'),
  ('71000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000002', 'completed', 'en');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, original_language, canonical_english_text, needs_review) values
  ('72000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', '71000000-0000-0000-0000-000000000001', 0, 0, 4500, 'I want Python backend roles.', 'en', 'I want Python backend roles.', false),
  ('72000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000c', '71000000-0000-0000-0000-000000000002', 0, 0, 3000, 'Unrelated meeting content.', 'en', 'Unrelated meeting content.', false);

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
-- 1. Anon denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.ai_runs $$, '42501', null, '1a. Anon cannot select ai_runs');
select throws_ok($$ select count(*) from public.call_records $$, '42501', null, '1b. Anon cannot select call_records');

-- ---------------------------------------------------------------------
-- 2. No authenticated write grant at all — worker/RPC only.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('68000000-0000-0000-0000-000000000002'); -- AM P1, owner

select throws_ok(
  $$ insert into public.ai_runs (organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'x', 'v1', 'v1') $$,
  '42501', null, '2a. No authenticated role can insert ai_runs (service_role/RPC only)'
);

select throws_ok(
  $$ select public.complete_meeting_intelligence_run('00000000-0000-0000-0000-000000000000'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid, 'x', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb) $$,
  '42501', null, '2b. Authenticated cannot execute complete_meeting_intelligence_run (service_role only)'
);

select throws_ok(
  $$ select public.materialize_customer_truth_deltas('00000000-0000-0000-0000-000000000000'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid) $$,
  '42501', null, '2c. Authenticated cannot execute materialize_customer_truth_deltas (service_role only)'
);

-- ---------------------------------------------------------------------
-- 3. Service-role-equivalent (table owner bypasses RLS, established
--    convention) setup + org-consistency + evidence + identity checks.
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$ insert into public.ai_runs (organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
     values ('39000000-0000-0000-0000-00000000000d', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'x', 'v1', 'v1') $$,
  'P0001', null, '3a. ai_runs.meeting_id must belong to the same organization'
);

insert into public.ai_runs (id, organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
values ('73000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'openai/gpt-4o', 'v1', 'v1');

select throws_ok(
  $$ insert into public.ai_runs (organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'openai/gpt-4o', 'v1', 'v1') $$,
  '23505', null, '3b. The identity tuple (meeting, transcript, run_type, model, prompt_version, config_version) is unique — a re-enqueue with the SAME identity is rejected, not duplicated (correction #2)'
);

select lives_ok(
  $$ insert into public.ai_runs (organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'openai/gpt-4o', 'v2', 'v1') $$,
  '3c. A deliberate prompt_version bump creates a genuinely new identity row rather than being blocked'
);

-- Codex plan review (SHOULD-FIX, fixed): same-org alone wasn't enough —
-- meeting 2's transcript is same-org as meeting 1 but belongs to a
-- DIFFERENT meeting, and must be rejected when attached to meeting 1's run.
select throws_ok(
  $$ insert into public.ai_runs (organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002', 'openai/gpt-4o', 'v3', 'v1') $$,
  'P0001', null, '3g. ai_runs.transcript_id must belong to ai_runs.meeting_id (same-org alone is not enough — a same-org transcript from a DIFFERENT meeting is rejected)'
);

select throws_ok(
  $$ insert into public.call_records (organization_id, meeting_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 'action_item', 'x', 'am', '{}') $$,
  '23514', null, '3d. call_records.evidence_segment_ids must not be empty (CHECK constraint)'
);

select throws_ok(
  $$ insert into public.call_records (organization_id, meeting_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 'action_item', 'x', 'am',
             array['72000000-0000-0000-0000-000000000002']::uuid[]) $$,
  'P0001', null, '3e. call_records.evidence_segment_ids referencing a DIFFERENT meeting''s segment is rejected (evidence-integrity trigger)'
);

select lives_ok(
  $$ insert into public.call_records (organization_id, meeting_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids)
     values ('39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 'action_item', 'valid', 'am',
             array['72000000-0000-0000-0000-000000000001']::uuid[]) $$,
  '3f. call_records.evidence_segment_ids referencing THIS meeting''s own segment is accepted'
);
delete from public.call_records where ai_run_id = '73000000-0000-0000-0000-000000000001';
delete from public.ai_runs where id != '73000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------
-- 4. Select visibility mirrors meeting visibility (owner/admin/sibling/
--    cross-org), and call_records visibility is meeting-scoped, not
--    customer-scoped (redesign doc §13).
-- ---------------------------------------------------------------------
insert into public.call_records (id, organization_id, meeting_id, customer_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids)
values ('74000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000c', '70000000-0000-0000-0000-000000000001', '69000000-0000-0000-0000-000000000001', '73000000-0000-0000-0000-000000000001', 'action_item', 'Follow up on Python roles', 'am', array['72000000-0000-0000-0000-000000000001']::uuid[]);

select pg_temp.tests_as('68000000-0000-0000-0000-000000000002'); -- AM P1, owns the meeting

select is(
  (select count(*)::int from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  1,
  '4a. The meeting owner can see its ai_runs row'
);

select is(
  (select description from public.call_records where id = '74000000-0000-0000-0000-000000000001'),
  'Follow up on Python roles',
  '4b. The meeting owner can see its call_records row'
);

select pg_temp.tests_as('68000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select count(*)::int from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  1,
  '4c. Org admin can see ai_runs org-wide'
);

select pg_temp.tests_as('68000000-0000-0000-0000-000000000003'); -- AM P2, sibling, doesn't own this meeting, doesn't own the customer either

select is(
  (select count(*)::int from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  0,
  '4d. A sibling AM who cannot see the meeting cannot see its ai_runs row'
);

select is(
  (select count(*)::int from public.call_records where id = '74000000-0000-0000-0000-000000000001'),
  0,
  '4e. A sibling AM who cannot see the meeting cannot see its call_records row (meeting-scoped, not customer-scoped, per the locked design)'
);

select pg_temp.tests_as('68000000-0000-0000-0000-000000000004'); -- AM Q1, cross-org

select is(
  (select count(*)::int from public.call_records where id = '74000000-0000-0000-0000-000000000001'),
  0,
  '4f. Cross-org membership cannot see the call_records row'
);

-- ---------------------------------------------------------------------
-- 5. claim_next_meeting_intelligence_run: FOR UPDATE SKIP LOCKED claim.
-- ---------------------------------------------------------------------
reset role;

select is(
  (select status::text from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  'pending',
  '5a. sanity: the run starts pending'
);

select is(
  (select status::text from public.claim_next_meeting_intelligence_run()),
  'running',
  '5b. claim_next_meeting_intelligence_run claims the pending row and marks it running'
);

select is(
  (select status::text from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  'running',
  '5c. the claimed row is persisted as running'
);

-- ---------------------------------------------------------------------
-- 6. complete_meeting_intelligence_run: atomic completion + call_records
--    insert, evidence-grade validated_output preserved, refuses a
--    second completion.
-- ---------------------------------------------------------------------
delete from public.call_records where ai_run_id = '73000000-0000-0000-0000-000000000001';

select is(
  public.complete_meeting_intelligence_run(
    '73000000-0000-0000-0000-000000000001'::uuid,
    '39000000-0000-0000-0000-00000000000c'::uuid,
    'Customer wants Python backend roles.',
    '{"summary":"Customer wants Python backend roles.","callRecords":[],"customerTruthDeltas":[{"fieldKey":"target_roles","proposedValue":"Python backend","confidence":0.9,"evidenceSegmentIds":["72000000-0000-0000-0000-000000000001"]}],"callTypeSpecific":null}'::jsonb,
    '{"promptTokens":100,"completionTokens":50,"cost":0.01}'::jsonb,
    '[{"record_type":"action_item","description":"Follow up on Python roles","owner_type":"am","evidence_segment_ids":["72000000-0000-0000-0000-000000000001"]}]'::jsonb
  ),
  true,
  '6a. complete_meeting_intelligence_run returns true and completes a running run'
);

select is(
  (select status::text from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  'completed',
  '6b. the run is marked completed'
);

select is(
  (select summary from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  'Customer wants Python backend roles.',
  '6c. the summary is persisted as its own column (M9 correction #4)'
);

select isnt(
  (select validated_output from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  null,
  '6d. the full validated_output is preserved (evidence-grade audit trail, M9 correction #3)'
);

select is(
  (select count(*)::int from public.call_records where ai_run_id = '73000000-0000-0000-0000-000000000001'),
  1,
  '6e. exactly one call_record was inserted atomically alongside completion'
);

select is(
  (select status::text from public.call_records where ai_run_id = '73000000-0000-0000-0000-000000000001'),
  'detected',
  '6f. the inserted call_record defaults to status=detected'
);

select is(
  public.complete_meeting_intelligence_run(
    '73000000-0000-0000-0000-000000000001'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid,
    'different summary', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb
  ),
  false,
  '6g. calling it again on an already-completed run returns false and touches nothing'
);

select is(
  (select summary from public.ai_runs where id = '73000000-0000-0000-0000-000000000001'),
  'Customer wants Python backend roles.',
  '6h. the original summary is untouched after the refused re-completion attempt'
);

-- ---------------------------------------------------------------------
-- 7. materialize_customer_truth_deltas: deferred materialization
--    (M9 correction #1) — no-ops while unlinked, materializes once
--    linked, is idempotent, and never writes status other than
--    'proposed' (M9 correction #5).
-- ---------------------------------------------------------------------
select is(
  (select customer_id from public.meetings where id = '70000000-0000-0000-0000-000000000001'),
  null,
  '7a. sanity: the meeting is still unlinked (needs_link)'
);

select is(
  public.materialize_customer_truth_deltas('73000000-0000-0000-0000-000000000001'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid),
  false,
  '7b. materialize_customer_truth_deltas no-ops (returns false) while the meeting has no customer_id — deltas are NOT discarded, just deferred'
);

select is(
  (select count(*)::int from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  0,
  '7c. nothing was written to customer_truth_facts yet'
);

update public.meetings set customer_id = '69000000-0000-0000-0000-000000000001', customer_link_status = 'linked_manual' where id = '70000000-0000-0000-0000-000000000001';

select is(
  public.materialize_customer_truth_deltas('73000000-0000-0000-0000-000000000001'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid),
  true,
  '7d. once linked, materialize_customer_truth_deltas succeeds using the ALREADY-STORED validated_output — no second AI call needed'
);

select is(
  (select count(*)::int from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  1,
  '7e. exactly one customer_truth_facts row was materialized'
);

select is(
  (select status::text from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  'proposed',
  '7f. the materialized fact is status=proposed — M9 never writes confirmed (correction #5, enforced by the function signature, not convention)'
);

select is(
  (select source_type::text from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  'meeting',
  '7g. the materialized fact has source_type=meeting'
);

select is(
  (select previous_fact_id from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  null,
  '7h. previous_fact_id is left null by M9 — computing supersession is M10''s (confirm-time) responsibility, not proposal-time'
);

select is(
  public.materialize_customer_truth_deltas('73000000-0000-0000-0000-000000000001'::uuid, '39000000-0000-0000-0000-00000000000c'::uuid),
  false,
  '7i. calling materialize_customer_truth_deltas again is idempotent — already materialized, no duplicate facts'
);

select is(
  (select count(*)::int from public.customer_truth_facts where source_meeting_id = '70000000-0000-0000-0000-000000000001'),
  1,
  '7j. still exactly one materialized fact after the redundant call'
);

-- ---------------------------------------------------------------------
-- 8. customer_truth_facts evidence-integrity trigger rejects an evidence
--    id from a different meeting's transcript.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, source_meeting_id, evidence_segment_ids)
     values ('39000000-0000-0000-0000-00000000000c', '69000000-0000-0000-0000-000000000001', 'target_roles', '"x"'::jsonb, 'proposed', 'meeting', '70000000-0000-0000-0000-000000000001', array['72000000-0000-0000-0000-000000000002']::uuid[]) $$,
  'P0001', null, '8a. customer_truth_facts.evidence_segment_ids referencing a DIFFERENT meeting''s segment is rejected'
);

select * from finish();
rollback;
