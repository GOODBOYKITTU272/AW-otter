-- M8 meeting_transcripts / transcript_segments test matrix. Self-contained
-- fixtures, rolled back at the end. Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs, mirroring 008/009's shape.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, email_domain) values
  ('39000000-0000-0000-0000-00000000000a', 'M8 Test Org P', 'm8-test-org-p', 'm8p.test'),
  ('39000000-0000-0000-0000-00000000000b', 'M8 Test Org Q', 'm8-test-org-q', 'm8q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '62000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000a', 'admin-p@m8test.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '62000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000a', 'am-p1@m8test.test', 'AM P1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '62000000-0000-0000-0000-000000000003', '39000000-0000-0000-0000-00000000000a', 'am-p2@m8test.test', 'AM P2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '62000000-0000-0000-0000-000000000004', '39000000-0000-0000-0000-00000000000b', 'am-q1@m8test.test', 'AM Q1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '63000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m8test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '63000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@m8test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '63000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@m8test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '63000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-q1@m8test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('64000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000a', '62000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m8-1', 'M8 Test Meeting P1', 'teams', 'https://meet.example/m8p1', now() - interval '1 hour', now() - interval '30 minutes', 'record');

insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status, detected_language) values
  ('65000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000a', '64000000-0000-0000-0000-000000000001', 'completed', 'en');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, original_language, canonical_english_text, needs_review) values
  ('66000000-0000-0000-0000-000000000001', '39000000-0000-0000-0000-00000000000a', '65000000-0000-0000-0000-000000000001', 0, 0, 4500, 'We should shift toward Python.', 'en', 'We should shift toward Python.', false);

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

select throws_ok($$ select count(*) from public.meeting_transcripts $$, '42501', null, '1a. Anon cannot select meeting_transcripts');
select throws_ok($$ select count(*) from public.transcript_segments $$, '42501', null, '1b. Anon cannot select transcript_segments');

-- ---------------------------------------------------------------------
-- 2. Select visibility mirrors meeting visibility: owning AM, admin
--    org-wide, sibling AM denied (meetings visibility doesn't extend to
--    a non-owning sibling), cross-org denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('63000000-0000-0000-0000-000000000002'); -- AM P1, owns the meeting

select is(
  (select detected_language from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000001'),
  'en',
  '2a. The meeting owner can see its transcript'
);

select is(
  (select original_text from public.transcript_segments where id = '66000000-0000-0000-0000-000000000001'),
  'We should shift toward Python.',
  '2b. The meeting owner can see its transcript segments'
);

select pg_temp.tests_as('63000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select count(*)::int from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000001'),
  1,
  '2c. Org admin can see the transcript org-wide'
);

select pg_temp.tests_as('63000000-0000-0000-0000-000000000003'); -- AM P2, sibling, doesn't own this meeting

select is(
  (select count(*)::int from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000001'),
  0,
  '2d. A sibling AM who cannot see the meeting cannot see its transcript'
);

select is(
  (select count(*)::int from public.transcript_segments where id = '66000000-0000-0000-0000-000000000001'),
  0,
  '2e. A sibling AM who cannot see the meeting cannot see its transcript segments'
);

select pg_temp.tests_as('63000000-0000-0000-0000-000000000004'); -- AM Q1, cross-org

select is(
  (select count(*)::int from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000001'),
  0,
  '2f. Cross-org membership cannot see the transcript'
);

-- ---------------------------------------------------------------------
-- 3. No authenticated write grant at all — worker/service_role only.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('63000000-0000-0000-0000-000000000002'); -- AM P1, owner

select throws_ok(
  $$ update public.meeting_transcripts set processing_status = 'failed' where id = '65000000-0000-0000-0000-000000000001' $$,
  '42501', null, '3a. No authenticated role can update meeting_transcripts (service_role only)'
);

select throws_ok(
  $$ insert into public.meeting_transcripts (organization_id, meeting_id) values ('39000000-0000-0000-0000-00000000000a', '64000000-0000-0000-0000-000000000001') $$,
  '42501', null, '3b. No authenticated role can insert meeting_transcripts (service_role only)'
);

select throws_ok(
  $$ update public.transcript_segments set original_text = 'tampered' where id = '66000000-0000-0000-0000-000000000001' $$,
  '42501', null, '3c. No authenticated role can update transcript_segments (service_role only)'
);

-- ---------------------------------------------------------------------
-- 4. Service-role-equivalent (table owner bypasses RLS, same convention
--    008/009 use) writes work, and constraints/idempotency hold.
-- ---------------------------------------------------------------------
reset role;

select lives_ok(
  $$ update public.meeting_transcripts set processing_status = 'processing' where id = '65000000-0000-0000-0000-000000000001' $$,
  '4a. service_role (table owner) can update meeting_transcripts'
);

select throws_ok(
  $$ insert into public.meeting_transcripts (organization_id, meeting_id) values ('39000000-0000-0000-0000-00000000000a', '64000000-0000-0000-0000-000000000001') $$,
  '23505', null, '4b. (organization_id, meeting_id) must be unique — a second transcript for the same meeting is rejected, not duplicated'
);

select throws_ok(
  $$ insert into public.transcript_segments (organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text)
     values ('39000000-0000-0000-0000-00000000000a', '65000000-0000-0000-0000-000000000001', 0, 0, 100, 'duplicate sequence') $$,
  '23505', null, '4c. (transcript_id, sequence_index) must be unique — a duplicate segment index is rejected'
);

select throws_ok(
  $$ insert into public.transcript_segments (organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text)
     values ('39000000-0000-0000-0000-00000000000a', '65000000-0000-0000-0000-000000000001', 99, 100, 50, 'reversed timing') $$,
  '23514', null, '4d. end_ms must be >= start_ms (CHECK constraint)'
);

select throws_ok(
  $$ insert into public.transcript_segments (organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text)
     values ('39000000-0000-0000-0000-00000000000a', '65000000-0000-0000-0000-000000000001', 99, -5, 10, 'negative start') $$,
  '23514', null, '4e. start_ms must be >= 0 (CHECK constraint)'
);

-- Codex post-implementation review NIT: `reset role` (used throughout this
-- file, matching 008/009's own convention) runs as the table owner —
-- which bypasses grants entirely and would NOT have caught the earlier
-- BLOCKING finding that service_role had never actually been granted
-- DELETE. This checks the REAL service_role grant set directly: it now
-- has no DELETE at all (by design — all segment deletes must go through
-- complete_transcription_job, a SECURITY DEFINER function that doesn't
-- need or get a direct grant).
set role service_role;
select throws_ok(
  $$ delete from public.transcript_segments where id = '66000000-0000-0000-0000-000000000001' $$,
  '42501', null, '4f. service_role has NO direct DELETE grant on transcript_segments (real role check, not table-owner bypass)'
);
reset role;

-- ---------------------------------------------------------------------
-- 5. Org-consistency triggers.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ insert into public.meeting_transcripts (organization_id, meeting_id) values ('39000000-0000-0000-0000-00000000000b', '64000000-0000-0000-0000-000000000001') $$,
  'P0001', null, '5a. meeting_transcripts.meeting_id must belong to the same organization'
);

-- ---------------------------------------------------------------------
-- 6. Evidence immutability: once a transcript is 'completed', its
--    segments' evidence fields can never change again — even for
--    service_role, the only role with any write grant at all.
-- ---------------------------------------------------------------------
select is(
  (select processing_status::text from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000001'),
  'processing',
  '6a. sanity: transcript is currently processing (not yet completed) after step 4a'
);

select lives_ok(
  $$ update public.transcript_segments set original_text = 'still mutable while not completed' where id = '66000000-0000-0000-0000-000000000001' $$,
  '6b. original_text is still mutable while the parent transcript is NOT yet completed'
);

update public.meeting_transcripts set processing_status = 'completed' where id = '65000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.transcript_segments set original_text = 'tampered evidence' where id = '66000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '6c. original_text becomes immutable once the parent transcript is completed, even for service_role'
);

select lives_ok(
  $$ update public.transcript_segments set canonical_english_text = 'a later normalization pass result', translation_confidence = 0.8 where id = '66000000-0000-0000-0000-000000000001' $$,
  '6d. canonical_english_text/translation_confidence remain mutable after completion (the normalization stage runs as a deliberate follow-up write)'
);

-- ---------------------------------------------------------------------
-- 7. Evidence deletion is blocked too (not just UPDATE) once completed —
--    a second, independent layer beyond the missing DELETE grant tested
--    in 4f. Tested at table-owner privilege specifically to isolate the
--    TRIGGER's own behavior from the grant check.
-- ---------------------------------------------------------------------
select throws_ok(
  $$ delete from public.transcript_segments where id = '66000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '7a. Deleting a segment is blocked once its parent transcript is completed, even at table-owner privilege (BEFORE DELETE trigger)'
);

-- ---------------------------------------------------------------------
-- 8. complete_transcription_job: atomic delete+insert+complete in one
--    transaction, and refuses to touch an already-completed transcript's
--    evidence (the actual fix for both BLOCKING findings).
-- ---------------------------------------------------------------------
insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('64000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000a', '62000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m8-2', 'M8 Test Meeting P2', 'teams', 'https://meet.example/m8p2', now() - interval '2 hours', now() - interval '90 minutes', 'record');

insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status) values
  ('65000000-0000-0000-0000-000000000002', '39000000-0000-0000-0000-00000000000a', '64000000-0000-0000-0000-000000000002', 'processing');

select is(
  public.complete_transcription_job(
    '65000000-0000-0000-0000-000000000002'::uuid,
    '39000000-0000-0000-0000-00000000000a'::uuid,
    'test-model', 'en', true, '{}'::jsonb, '{}'::jsonb, 10.5, 0.001,
    '[{"sequence_index":0,"start_ms":0,"end_ms":900,"original_text":"hello","original_language":"en","canonical_english_text":"hello","needs_review":false}]'::jsonb
  ),
  true,
  '8a. complete_transcription_job returns true and completes a pending transcript'
);

select is(
  (select processing_status::text from public.meeting_transcripts where id = '65000000-0000-0000-0000-000000000002'),
  'completed',
  '8b. the transcript is marked completed'
);

select is(
  (select count(*)::int from public.transcript_segments where transcript_id = '65000000-0000-0000-0000-000000000002'),
  1,
  '8c. exactly one segment was inserted'
);

select is(
  public.complete_transcription_job(
    '65000000-0000-0000-0000-000000000002'::uuid,
    '39000000-0000-0000-0000-00000000000a'::uuid,
    'different-model', 'te', false, '{}'::jsonb, '{}'::jsonb, 99, 99,
    '[{"sequence_index":0,"start_ms":0,"end_ms":900,"original_text":"tampered replacement","needs_review":true}]'::jsonb
  ),
  false,
  '8d. calling it again on an already-completed transcript returns false and touches nothing'
);

select is(
  (select original_text from public.transcript_segments where transcript_id = '65000000-0000-0000-0000-000000000002'),
  'hello',
  '8e. the original segment is untouched after the refused re-completion attempt'
);

select * from finish();
rollback;
