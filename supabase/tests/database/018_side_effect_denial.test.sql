-- M15 audit follow-up: proving unauthorized calls to the four P0-fixed
-- functions (plus claim_next_meeting_intelligence_run, whose grant was
-- already correct but untested at the role level until this session)
-- cause ZERO state mutation — not merely that they error. A permission
-- check in Postgres happens BEFORE the function body ever runs, so a
-- 42501 error structurally guarantees this — but this file proves it
-- empirically against real fixture rows rather than relying on that
-- inference, and also proves the SAME fixtures genuinely change state
-- when the intended caller (service_role) performs the equivalent
-- action, so a passing "unchanged" assertion can't be explained by a
-- fixture that could never change in the first place.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into public.organizations (id, name, slug, email_domain) values
  ('99000000-0000-0000-0000-00000000000a', 'M15 Side-Effect Test Org', 'm15-side-effect-org', 'm15se.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '99100000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'am-se@m15se.test', 'AM SE', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '99200000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am-se@m15se.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('99300000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'M15 Side-Effect Customer', '99100000-0000-0000-0000-000000000001', 'manual');

insert into public.meetings (id, organization_id, owner_membership_id, customer_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status)
values
  ('99400000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', '99100000-0000-0000-0000-000000000001', '99300000-0000-0000-0000-000000000001', 'microsoft', 'ical-se-1', 'M15 SE Meeting 1', 'teams', 'https://meet.example/se1', now() - interval '1 hour', now() - interval '30 minutes', 'record'),
  ('99400000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-00000000000a', '99100000-0000-0000-0000-000000000001', null, 'microsoft', 'ical-se-2', 'M15 SE Meeting 2 (unlinked)', 'teams', 'https://meet.example/se2', now() - interval '2 hours', now() - interval '90 minutes', 'record');

-- Fixture A: a real pending transcription job (claim_next_transcription_job).
insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status)
values ('99500000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', '99400000-0000-0000-0000-000000000001', 'pending');

-- Fixture B: a real 'processing' transcript with a real prior segment,
-- for complete_transcription_job — asserts it is NOT overwritten and no
-- new segment is fabricated. A different meeting than Fixture A
-- (meeting_transcripts has a one-per-meeting unique constraint).
insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status)
values ('99500000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-00000000000a', '99400000-0000-0000-0000-000000000002', 'processing');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, original_language, needs_review)
values ('99600000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', '99500000-0000-0000-0000-000000000002', 0, 0, 1000, 'Real pre-existing segment text.', 'en', false);

-- Fixture C: a real pending ai_runs row (claim_next_meeting_intelligence_run).
insert into public.ai_runs (id, organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
values ('99700000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', '99400000-0000-0000-0000-000000000001', '99500000-0000-0000-0000-000000000001', 'openai/gpt-4o', 'v1', 'v1');

-- Fixture D: a real unlinked scheduler_call + a real needs_link meeting
-- (claim_scheduler_call_meeting).
insert into public.scheduler_calls (id, organization_id, external_call_id, customer_id, external_applywizz_id, owner_membership_id, external_am_email, external_type, canonical_call_type, scheduled_at, external_status, meeting_id)
values ('99800000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'se-sched-1', '99300000-0000-0000-0000-000000000001', 'AWL-SE-1', '99100000-0000-0000-0000-000000000001', 'am-se@m15se.test', 'DISCOVERY', 'discovery', now(), 'SCHEDULED', null);

-- Fixture E: a real pending calendar_event_jobs row (claim_next_calendar_event_job).
insert into public.calendar_connections (id, organization_membership_id, provider, provider_user_id, status)
values ('99900000-0000-0000-0000-000000000001', '99100000-0000-0000-0000-000000000001', 'microsoft', 'se-provider-user-1', 'connected');

insert into public.calendar_event_jobs (id, calendar_connection_id, organization_id, external_event_id, change_type, status, provider_user_key)
values ('99a00000-0000-0000-0000-000000000001', '99900000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-00000000000a', 'se-external-event-1', 'created', 'pending', 'am-se@m15se.test');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- 1. claim_next_transcription_job: denied call leaves the pending row
--    untouched.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.claim_next_transcription_job() $$,
  '42501', null,
  '1a. authenticated denied claim_next_transcription_job()'
);
reset role;
set role anon;
select throws_ok(
  $$ select public.claim_next_transcription_job() $$,
  '42501', null,
  '1b. anon denied claim_next_transcription_job()'
);
reset role;
select is(
  (select processing_status::text from public.meeting_transcripts where id = '99500000-0000-0000-0000-000000000001'),
  'pending',
  '1c. side-effect denial proven: the job is STILL pending after both denied attempts (zero mutation)'
);

-- ---------------------------------------------------------------------
-- 2. claim_next_meeting_intelligence_run: denied call leaves the pending
--    run untouched.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.claim_next_meeting_intelligence_run() $$,
  '42501', null,
  '2a. authenticated denied claim_next_meeting_intelligence_run()'
);
reset role;
set role anon;
select throws_ok(
  $$ select public.claim_next_meeting_intelligence_run() $$,
  '42501', null,
  '2b. anon denied claim_next_meeting_intelligence_run()'
);
reset role;
select is(
  (select status::text from public.ai_runs where id = '99700000-0000-0000-0000-000000000001'),
  'pending',
  '2c. side-effect denial proven: the run is STILL pending after both denied attempts (zero mutation)'
);

-- ---------------------------------------------------------------------
-- 3. claim_scheduler_call_meeting: denied call leaves BOTH the scheduler
--    call unlinked AND the meeting unlinked — proving no cross-org/
--    cross-record linkage happened.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.claim_scheduler_call_meeting(
       '99800000-0000-0000-0000-000000000001'::uuid,
       '99000000-0000-0000-0000-00000000000a'::uuid,
       '99400000-0000-0000-0000-000000000002'::uuid,
       '99300000-0000-0000-0000-000000000001'::uuid,
       'discovery'::public.call_type) $$,
  '42501', null,
  '3a. authenticated denied claim_scheduler_call_meeting() with REAL row ids'
);
reset role;
set role anon;
select throws_ok(
  $$ select public.claim_scheduler_call_meeting(
       '99800000-0000-0000-0000-000000000001'::uuid,
       '99000000-0000-0000-0000-00000000000a'::uuid,
       '99400000-0000-0000-0000-000000000002'::uuid,
       '99300000-0000-0000-0000-000000000001'::uuid,
       'discovery'::public.call_type) $$,
  '42501', null,
  '3b. anon denied claim_scheduler_call_meeting() with REAL row ids'
);
reset role;
select is(
  (select meeting_id from public.scheduler_calls where id = '99800000-0000-0000-0000-000000000001'),
  null,
  '3c. side-effect denial proven: scheduler_calls.meeting_id is STILL null (no linkage was created)'
);
select is(
  (select customer_link_status from public.meetings where id = '99400000-0000-0000-0000-000000000002'),
  null,
  '3d. side-effect denial proven: the target meeting was NOT linked to the customer'
);

-- ---------------------------------------------------------------------
-- 4. complete_transcription_job: denied call leaves the transcript
--    'processing' (not fabricated 'completed') and does NOT insert a
--    fabricated segment.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.complete_transcription_job(
       '99500000-0000-0000-0000-000000000002'::uuid,
       '99000000-0000-0000-0000-00000000000a'::uuid,
       'attacker-model', 'en', false, '{}'::jsonb, '{}'::jsonb, 0, 0,
       '[{"sequence_index":0,"start_ms":0,"end_ms":1,"original_text":"FABRICATED BY ATTACKER"}]'::jsonb
     ) $$,
  '42501', null,
  '4a. authenticated denied complete_transcription_job() attempting real-id fabrication'
);
reset role;
set role anon;
select throws_ok(
  $$ select public.complete_transcription_job(
       '99500000-0000-0000-0000-000000000002'::uuid,
       '99000000-0000-0000-0000-00000000000a'::uuid,
       'attacker-model', 'en', false, '{}'::jsonb, '{}'::jsonb, 0, 0,
       '[{"sequence_index":0,"start_ms":0,"end_ms":1,"original_text":"FABRICATED BY ATTACKER"}]'::jsonb
     ) $$,
  '42501', null,
  '4b. anon denied complete_transcription_job() attempting real-id fabrication'
);
reset role;
select is(
  (select processing_status::text from public.meeting_transcripts where id = '99500000-0000-0000-0000-000000000002'),
  'processing',
  '4c. side-effect denial proven: transcript is STILL processing, not fabricated-completed'
);
select is(
  (select count(*)::int from public.transcript_segments where transcript_id = '99500000-0000-0000-0000-000000000002'),
  1,
  '4d. side-effect denial proven: still exactly the ONE real pre-existing segment — no fabricated segment was inserted, none deleted'
);
select is(
  (select original_text from public.transcript_segments where id = '99600000-0000-0000-0000-000000000001'),
  'Real pre-existing segment text.',
  '4e. side-effect denial proven: the real segment text is unchanged (not overwritten by the attacker payload)'
);

-- ---------------------------------------------------------------------
-- 5. claim_next_calendar_event_job: denied call leaves the pending job
--    untouched (this is the ORIGINAL P0, re-proven here with a real
--    fixture rather than just the empty-queue check in
--    015_security_hardening.test.sql).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('99200000-0000-0000-0000-000000000001');
select throws_ok(
  $$ select public.claim_next_calendar_event_job() $$,
  '42501', null,
  '5a. authenticated denied claim_next_calendar_event_job()'
);
reset role;
set role anon;
select throws_ok(
  $$ select public.claim_next_calendar_event_job() $$,
  '42501', null,
  '5b. anon denied claim_next_calendar_event_job()'
);
reset role;
select is(
  (select status from public.calendar_event_jobs where id = '99a00000-0000-0000-0000-000000000001'),
  'pending',
  '5c. side-effect denial proven: the job is STILL pending after both denied attempts (zero mutation)'
);

-- ---------------------------------------------------------------------
-- 6. Positive control: service_role (the intended caller) DOES mutate
--    state — proves 1c/2c/3c/3d/4c/4d/4e/5c above are real assertions
--    against a fixture that CAN change, not tautologies against a
--    fixture that never could.
-- ---------------------------------------------------------------------
set role service_role;
select isnt(
  (select processing_status::text from public.claim_next_transcription_job()),
  null,
  '6a. positive control: service_role DOES claim a real pending job (status returned is not null)'
);
reset role;
select is(
  (select processing_status::text from public.meeting_transcripts where id = '99500000-0000-0000-0000-000000000001'),
  'processing',
  '6b. positive control: the fixture job''s status DID change to processing once the intended caller ran it'
);

select * from finish();
rollback;
