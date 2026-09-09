-- M15 security audit (P0 findings, fixed in
-- 20260911150002_revoke_more_queue_claim_public_execute.sql and
-- 20260911150003_revoke_complete_transcription_job_public_execute.sql):
-- an exhaustive SECURITY DEFINER/RPC exposure matrix (queried directly
-- from pg_proc/has_function_privilege) found three more functions with
-- the same "grant to service_role but never revoke PUBLIC's default
-- EXECUTE grant" gap already found and fixed once for
-- claim_next_calendar_event_job (015_security_hardening.test.sql).
-- No fixtures needed — pure role-privilege checks, not row-visibility
-- checks. Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

set role authenticated;
select throws_ok(
  $$ select public.claim_next_transcription_job() $$,
  '42501', null,
  '1a. authenticated cannot call claim_next_transcription_job()'
);
select throws_ok(
  $$ select public.claim_scheduler_call_meeting(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'discovery'::public.call_type) $$,
  '42501', null,
  '1b. authenticated cannot call claim_scheduler_call_meeting() with arbitrary ids'
);
select throws_ok(
  $$ select public.complete_transcription_job(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'fake-model', 'en', false, '{}'::jsonb, '{}'::jsonb, 0, 0, '[]'::jsonb) $$,
  '42501', null,
  '1c. authenticated cannot call complete_transcription_job() to inject arbitrary segments'
);

reset role;
set role anon;
select throws_ok(
  $$ select public.claim_next_transcription_job() $$,
  '42501', null,
  '2a. anon cannot call claim_next_transcription_job()'
);
select throws_ok(
  $$ select public.claim_scheduler_call_meeting(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'discovery'::public.call_type) $$,
  '42501', null,
  '2b. anon cannot call claim_scheduler_call_meeting() with arbitrary ids'
);
select throws_ok(
  $$ select public.complete_transcription_job(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'fake-model', 'en', false, '{}'::jsonb, '{}'::jsonb, 0, 0, '[]'::jsonb) $$,
  '42501', null,
  '2c. anon cannot call complete_transcription_job() to inject arbitrary segments'
);

reset role;
set role service_role;
select lives_ok(
  $$ select public.claim_next_transcription_job() $$,
  '3a. service_role (the intended caller) can still call claim_next_transcription_job()'
);
select lives_ok(
  $$ select public.claim_scheduler_call_meeting(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'discovery'::public.call_type) $$,
  '3b. service_role (the intended caller) can still call claim_scheduler_call_meeting()'
);
select lives_ok(
  $$ select public.complete_transcription_job(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000001'::uuid,
       'fake-model', 'en', false, '{}'::jsonb, '{}'::jsonb, 0, 0, '[]'::jsonb) $$,
  '3c. service_role (the intended caller) can still call complete_transcription_job()'
);
reset role;

select * from finish();
rollback;
