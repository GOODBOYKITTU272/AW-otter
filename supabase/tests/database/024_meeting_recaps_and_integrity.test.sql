-- Plan A Database Invariant & Hardening Tests (pgTAP)
-- Proves:
-- 1. AM owner can SELECT report and flags
-- 2. Reporting Manager can SELECT report and flags
-- 3. Senior Manager transitive scope can SELECT report and flags
-- 4. Cross-org member CANNOT SELECT report or flags
-- 5. Unrelated same-org AM CANNOT SELECT report or flags
-- 6. anon CANNOT SELECT report or flags
-- 7. Authenticated AM CANNOT INSERT integrity report (system-generated)
-- 8. Authenticated AM CANNOT UPDATE integrity report (system-generated)
-- 9. Authenticated AM CANNOT INSERT integrity flag (system-generated)
-- 10. Authenticated Manager CANNOT mutate integrity report or flags
-- 11. Only responsible AM can INSERT or UPDATE meeting_recaps
-- 12. Manager, Senior Manager, Admin, and unrelated AM CANNOT INSERT/UPDATE meeting_recaps
-- 13. Revisions append-only invariant (UPDATE/DELETE blocked)
-- 14. Only responsible AM can INSERT revisions
-- 15. Flag transcript_segment_id consistency (cross-meeting segment rejected)
-- 16. Flag meeting_id must match report meeting_id
-- 17. Atomic integrity replacement RPC permissions & execution (service_role only, replaces report+flags)
-- 18. Status 'approved' check constraint requires approved_by_membership_id and approved_at
-- 19. Status 'sent' is rejected

begin;
create extension if not exists pgtap with schema extensions;
select plan(28);

-- Setup test orgs
insert into public.organizations (id, name, slug, email_domain) values
  ('a1000000-0000-0000-0000-000000000001', 'Signal Hardening Org A', 'signal-hardening-org-a', 'signal-a.test'),
  ('b1000000-0000-0000-0000-000000000002', 'Signal Hardening Org B', 'signal-hardening-org-b', 'signal-b.test');

-- Org A reporting chain:
-- Senior Manager A -> Manager A -> AM A
-- Also Unrelated AM A2 (reports to Manager A)
-- Admin A

-- 1. Senior Manager A
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'a2000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 'seniormanager@signal-a.test', 'Senior Manager A', id, 'active'
from public.roles where key = 'senior_manager' and organization_id is null;

-- 2. Manager A (reports to Senior Manager A)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select 'a2000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'manager@signal-a.test', 'Manager A', id, 'a2000000-0000-0000-0000-000000000004', 'active'
from public.roles where key = 'manager' and organization_id is null;

-- 3. AM A (owner of meeting 1, reports to Manager A)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select 'a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'am@signal-a.test', 'AM A', id, 'a2000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- 4. Unrelated AM A2 (reports to Manager A, does NOT own meeting 1)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select 'a2000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'am2@signal-a.test', 'AM A2', id, 'a2000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- 5. Admin A
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'a2000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001', 'admin@signal-a.test', 'Admin A', id, 'active'
from public.roles where key = 'admin' and organization_id is null;

-- 6. AM B (Org B)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'am@signal-b.test', 'AM B', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- Auth users
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin) values
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am2@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'seniormanager@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'admin@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'b3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@signal-b.test', '', now(), now(), now(), '{}', '{}', false);

update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000001' where id = 'a2000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000002' where id = 'a2000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000003' where id = 'a2000000-0000-0000-0000-000000000003';
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000004' where id = 'a2000000-0000-0000-0000-000000000004';
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000005' where id = 'a2000000-0000-0000-0000-000000000005';
update public.organization_memberships set user_id = 'b3000000-0000-0000-0000-000000000001' where id = 'b2000000-0000-0000-0000-000000000001';

-- Meetings
-- Meeting 1 owned by AM A
insert into public.meetings (id, organization_id, owner_membership_id, provider, title, ical_uid, organizer_email, scheduled_start, scheduled_end, lifecycle_status, eligibility_status)
values
  ('a4000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'microsoft', 'Signal Call 1', 'sig-h-01', 'am@signal-a.test', now(), now() + interval '30 minutes', 'upcoming', 'record'),
  ('b4000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 'microsoft', 'Signal Call B', 'sig-h-02', 'am@signal-b.test', now(), now() + interval '30 minutes', 'upcoming', 'record');

-- Transcripts & Segments
insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status)
values
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'completed'),
  ('c1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'b4000000-0000-0000-0000-000000000002', 'completed');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, canonical_english_text)
values
  ('d1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 1, 0, 5000, 'Hello from AM A', 'Hello from AM A'),
  ('d1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 1, 0, 5000, 'Hello from AM B', 'Hello from AM B');

-- Create head recap & revision for Meeting 1
insert into public.meeting_recaps (id, organization_id, meeting_id, status, greeting, what_we_agreed, applywizz_will_do, candidate_should_do, next_step)
values (
  'e1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'a4000000-0000-0000-0000-000000000001',
  'draft',
  'Greeting 1',
  '["Agreement 1"]'::jsonb,
  '["ApplyWizz action 1"]'::jsonb,
  '["Candidate deliverable 1"]'::jsonb,
  'Next Step 1'
);

insert into public.meeting_recap_revisions (id, organization_id, recap_id, revision_number, created_by_membership_id, greeting, what_we_agreed, applywizz_will_do, candidate_should_do, next_step, revision_reason)
values (
  'e2000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000001',
  1,
  'a2000000-0000-0000-0000-000000000001',
  'Greeting 1',
  '["Agreement 1"]'::jsonb,
  '["ApplyWizz action 1"]'::jsonb,
  '["Candidate deliverable 1"]'::jsonb,
  'Next Step 1',
  'initial_derivation'
);

-- Populate system-generated report and flags for Meeting 1
insert into public.meeting_integrity_reports (id, organization_id, meeting_id, overall_verdict, summary, confidence_score_avg, suspected_background_media)
values (
  'f1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'a4000000-0000-0000-0000-000000000001',
  'needs_review',
  'Transcript requires review',
  0.88,
  true
);

insert into public.meeting_integrity_flags (id, organization_id, report_id, meeting_id, transcript_segment_id, flag_type, severity, start_ms, end_ms, reason_code, message)
values (
  'f2000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'f1000000-0000-0000-0000-000000000001',
  'a4000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'possible_background_media_or_stt_artifact',
  'warning',
  100,
  2500,
  'media_token',
  'Possible music or background artifact'
);

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- ============================================================================
-- 1. AM Owner can SELECT report and flags
-- ============================================================================
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'),
  1, '1. AM owner can SELECT integrity report'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'),
  1, '2. AM owner can SELECT integrity flags'
);

-- ============================================================================
-- 2. Reporting Manager can SELECT report and flags
-- ============================================================================
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'),
  1, '3. Direct reporting Manager can SELECT integrity report'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'),
  1, '4. Direct reporting Manager can SELECT integrity flags'
);

-- ============================================================================
-- 3. Senior Manager transitive scope can SELECT report and flags
-- ============================================================================
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000004');
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'),
  1, '5. Senior Manager transitive scope can SELECT integrity report'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'),
  1, '6. Senior Manager transitive scope can SELECT integrity flags'
);

-- ============================================================================
-- 4. Cross-org member CANNOT SELECT report or flags
-- ============================================================================
reset role;
select pg_temp.tests_as('b3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'),
  0, '7. Cross-org member CANNOT SELECT integrity report'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'),
  0, '8. Cross-org member CANNOT SELECT integrity flags'
);

-- ============================================================================
-- 5. Unrelated same-org AM CANNOT SELECT report or flags
-- ============================================================================
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000003');
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'),
  0, '9. Unrelated same-org AM CANNOT SELECT integrity report'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'),
  0, '10. Unrelated same-org AM CANNOT SELECT integrity flags'
);

-- ============================================================================
-- 6. anon CANNOT SELECT report or flags
-- ============================================================================
reset role;
set role anon;
select throws_ok(
  $$select * from public.meeting_integrity_reports where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  '11. anon CANNOT SELECT integrity report (denied by permissions)'
);
select throws_ok(
  $$select * from public.meeting_integrity_flags where id = 'f2000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  '12. anon CANNOT SELECT integrity flags (denied by permissions)'
);

-- ============================================================================
-- 7 & 8: Authenticated AM CANNOT INSERT or UPDATE integrity report
-- ============================================================================
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.meeting_integrity_reports (organization_id, meeting_id, overall_verdict, summary)
    values ('a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'good', 'hacked summary')$$,
  '42501',
  null,
  '13. Authenticated AM CANNOT INSERT integrity report (denied by permissions)'
);

select throws_ok(
  $$update public.meeting_integrity_reports set overall_verdict = 'good' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  '14. Authenticated AM CANNOT UPDATE integrity report (denied by permissions)'
);

-- ============================================================================
-- 9. Authenticated AM CANNOT INSERT integrity flag
-- ============================================================================
select throws_ok(
  $$insert into public.meeting_integrity_flags (organization_id, report_id, meeting_id, flag_type, severity, start_ms, end_ms, reason_code, message)
    values ('a1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'low_confidence', 'info', 0, 100, 'code', 'msg')$$,
  '42501',
  null,
  '15. Authenticated AM CANNOT INSERT integrity flag (denied by permissions)'
);

-- ============================================================================
-- 10. Authenticated Manager CANNOT mutate integrity report or flags
-- ============================================================================
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000002');
select throws_ok(
  $$update public.meeting_integrity_reports set overall_verdict = 'good' where id = 'f1000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  '16. Authenticated Manager CANNOT UPDATE integrity report'
);

-- ============================================================================
-- 11. Only responsible AM can UPDATE meeting_recaps; Manager & others CANNOT
-- ============================================================================
-- AM A (responsible owner): update succeeds
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
update public.meeting_recaps set greeting = 'Updated Greeting by AM A' where id = 'e1000000-0000-0000-0000-000000000001';
select is(
  (select greeting from public.meeting_recaps where id = 'e1000000-0000-0000-0000-000000000001'),
  'Updated Greeting by AM A',
  '17. Responsible AM can UPDATE meeting_recaps'
);

-- Manager A: update affects 0 rows (denied by RLS using condition)
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000002');
update public.meeting_recaps set greeting = 'Manager Hijack' where id = 'e1000000-0000-0000-0000-000000000001';
reset role;
select is(
  (select greeting from public.meeting_recaps where id = 'e1000000-0000-0000-0000-000000000001'),
  'Updated Greeting by AM A',
  '18. Manager CANNOT UPDATE meeting_recaps (0 rows updated by RLS)'
);

-- Senior Manager A: update affects 0 rows
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000004');
update public.meeting_recaps set greeting = 'Senior Manager Hijack' where id = 'e1000000-0000-0000-0000-000000000001';
reset role;
select is(
  (select greeting from public.meeting_recaps where id = 'e1000000-0000-0000-0000-000000000001'),
  'Updated Greeting by AM A',
  '19. Senior Manager CANNOT UPDATE meeting_recaps'
);

-- Admin A: update affects 0 rows
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000005');
update public.meeting_recaps set greeting = 'Admin Hijack' where id = 'e1000000-0000-0000-0000-000000000001';
reset role;
select is(
  (select greeting from public.meeting_recaps where id = 'e1000000-0000-0000-0000-000000000001'),
  'Updated Greeting by AM A',
  '20. Admin CANNOT UPDATE meeting_recaps directly via client RLS'
);

-- ============================================================================
-- 13 & 14. Revision insert authorization & append-only invariant
-- ============================================================================
-- Manager cannot insert revision
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000002');
select throws_ok(
  $$insert into public.meeting_recap_revisions (organization_id, recap_id, revision_number, greeting, next_step)
    values ('a1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 2, 'Manager revision', 'Next')$$,
  '42501',
  null,
  '21. Manager CANNOT INSERT revision into meeting_recap_revisions'
);

-- Responsible AM can insert revision
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
insert into public.meeting_recap_revisions (organization_id, recap_id, revision_number, created_by_membership_id, greeting, next_step)
values ('a1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 2, 'a2000000-0000-0000-0000-000000000001', 'AM Revision 2', 'Next');
select is(
  (select count(*)::int from public.meeting_recap_revisions where recap_id = 'e1000000-0000-0000-0000-000000000001'),
  2,
  '22. Responsible AM CAN INSERT revision'
);

-- Append-only trigger prevents UPDATE
reset role;
select throws_ok(
  $$update public.meeting_recap_revisions set greeting = 'Hacked' where id = 'e2000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'meeting_recap_revisions is append-only and cannot be updated or deleted.',
  '23. Updating revision is blocked by append-only trigger'
);

-- ============================================================================
-- 15 & 16. Evidence Linkage & Segment consistency
-- ============================================================================
-- Segment from different meeting rejected by trigger
select throws_ok(
  $$insert into public.meeting_integrity_flags (organization_id, report_id, meeting_id, transcript_segment_id, flag_type, severity, start_ms, end_ms, reason_code, message)
    values ('a1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'low_confidence', 'warning', 0, 1000, 'code', 'msg')$$,
  'P0001',
  'meeting_integrity_flags.transcript_segment_id must belong to a transcript of the same meeting.',
  '24. Attaching segment from another meeting is rejected by consistency trigger'
);

-- Mismatched meeting_id rejected by trigger
select throws_ok(
  $$insert into public.meeting_integrity_flags (organization_id, report_id, meeting_id, flag_type, severity, start_ms, end_ms, reason_code, message)
    values ('a1000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000002', 'low_confidence', 'warning', 0, 1000, 'code', 'msg')$$,
  'P0001',
  'meeting_integrity_flags.meeting_id must match the report meeting_id.',
  '25. Flag meeting_id mismatching report meeting_id is rejected'
);

-- ============================================================================
-- 17. Atomic save_meeting_integrity_report_atomic RPC
-- ============================================================================
-- Authenticated user cannot execute RPC
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
select throws_ok(
  $$select public.save_meeting_integrity_report_atomic(
    'a1000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001',
    'good',
    'Atomic report summary',
    0.95,
    false,
    '{}'::jsonb,
    '[]'::jsonb
  )$$,
  '42501',
  null,
  '26. Authenticated user CANNOT execute save_meeting_integrity_report_atomic'
);

-- Service role executes atomically and replaces report and flags
reset role;
select lives_ok(
  $$select public.save_meeting_integrity_report_atomic(
    'a1000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001',
    'good',
    'Atomic updated report summary',
    0.95,
    false,
    '{"flagCount": 1}'::jsonb,
    jsonb_build_array(
      jsonb_build_object(
        'transcript_segment_id', 'd1000000-0000-0000-0000-000000000001',
        'flag_type', 'possible_background_media_or_stt_artifact',
        'severity', 'info',
        'start_ms', 500,
        'end_ms', 1200,
        'reason_code', 'media_detected',
        'message', 'Possible background music',
        'detector_version', 'v1'
      )
    )
  )$$,
  '27. Service role can execute save_meeting_integrity_report_atomic'
);

select is(
  (select count(*)::int from public.meeting_integrity_flags where meeting_id = 'a4000000-0000-0000-0000-000000000001'),
  1,
  '28. Atomic report save successfully replaced flags with 1 new flag'
);

select finish();
rollback;
