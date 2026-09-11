-- P3D Speaker Interpretations Database & RLS Tests (pgTAP)
-- Proves:
-- 1. Responsible AM can SELECT speaker interpretations
-- 2. Reporting Manager can SELECT speaker interpretations
-- 3. Cross-org user CANNOT SELECT speaker interpretations
-- 4. Unrelated same-org AM CANNOT SELECT speaker interpretations
-- 5. Responsible AM can UPDATE / correct speaker interpretation
-- 6. Unrelated AM CANNOT UPDATE speaker interpretation
-- 7. Cross-org user CANNOT UPDATE speaker interpretation
-- 8. Human correction does NOT alter transcript_segments raw evidence

begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

-- Setup test orgs
insert into public.organizations (id, name, slug, email_domain) values
  ('c1000000-0000-0000-0000-000000000001', 'Speaker Test Org A', 'speaker-test-org-a', 'speaker-a.test'),
  ('d1000000-0000-0000-0000-000000000002', 'Speaker Test Org B', 'speaker-test-org-b', 'speaker-b.test');

-- Org A memberships:
-- Manager A -> AM A (owner)
-- Also Unrelated AM A2
-- Org B member

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'c2000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001', 'manager@speaker-a.test', 'Manager A', id, 'active'
from public.roles where key = 'manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select 'c2000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'am@speaker-a.test', 'AM A', id, 'c2000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'c2000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001', 'am2@speaker-a.test', 'AM A2', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'd2000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002', 'am@speaker-b.test', 'AM B', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- Auth users
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin) values
  ('00000000-0000-0000-0000-000000000000', 'c3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@speaker-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'c3000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager@speaker-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'c3000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am2@speaker-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'd3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@speaker-b.test', '', now(), now(), now(), '{}', '{}', false);

update public.organization_memberships set user_id = 'c3000000-0000-0000-0000-000000000001' where id = 'c2000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = 'c3000000-0000-0000-0000-000000000002' where id = 'c2000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = 'c3000000-0000-0000-0000-000000000003' where id = 'c2000000-0000-0000-0000-000000000003';
update public.organization_memberships set user_id = 'd3000000-0000-0000-0000-000000000001' where id = 'd2000000-0000-0000-0000-000000000001';

-- Create meeting owned by AM A
insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, scheduled_start, scheduled_end)
values (
  'c4000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'c2000000-0000-0000-0000-000000000001',
  'google',
  'ext-event-speaker-1',
  'Candidate Sync',
  now() - interval '1 hour',
  now() - interval '30 minutes'
);

-- Completed transcript with raw segment
insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status)
values (
  'c5000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'c4000000-0000-0000-0000-000000000001',
  'completed'
);

insert into public.transcript_segments (
  id, organization_id, transcript_id, sequence_index, start_ms, end_ms,
  original_text, original_language, speaker_label
) values (
  'c6000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'c5000000-0000-0000-0000-000000000001',
  0, 0, 3000,
  'Hello Kartik, this is Rama from Apply Wizz.',
  'en', 'Speaker 0'
);

-- Insert speaker interpretation (additive)
insert into public.meeting_speaker_interpretations (
  id, organization_id, meeting_id, transcript_id, raw_speaker_tag,
  business_role, interpreted_name, interpretation_source, interpretation_confidence
) values (
  'c7000000-0000-0000-0000-000000000001',
  'c1000000-0000-0000-0000-000000000001',
  'c4000000-0000-0000-0000-000000000001',
  'c5000000-0000-0000-0000-000000000001',
  'Speaker 0',
  'AM', 'Rama', 'self_introduction', 0.95
);

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- Test 1: Responsible AM can SELECT speaker interpretation
select pg_temp.tests_as('c3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_speaker_interpretations where meeting_id = 'c4000000-0000-0000-0000-000000000001'),
  1,
  'Responsible AM can select speaker interpretation for own meeting'
);

-- Test 2: Reporting Manager can SELECT speaker interpretation
select pg_temp.tests_as('c3000000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.meeting_speaker_interpretations where meeting_id = 'c4000000-0000-0000-0000-000000000001'),
  1,
  'Reporting manager can select speaker interpretation for supervisee meeting'
);

-- Test 3: Cross-org member CANNOT SELECT speaker interpretation
select pg_temp.tests_as('d3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_speaker_interpretations where meeting_id = 'c4000000-0000-0000-0000-000000000001'),
  0,
  'Cross-org member cannot select speaker interpretation'
);

-- Test 4: Unrelated same-org AM CANNOT SELECT speaker interpretation
select pg_temp.tests_as('c3000000-0000-0000-0000-000000000003');
select is(
  (select count(*)::int from public.meeting_speaker_interpretations where meeting_id = 'c4000000-0000-0000-0000-000000000001'),
  0,
  'Unrelated same-org AM cannot select speaker interpretation'
);

-- Test 5: Responsible AM can UPDATE / correct speaker interpretation
select pg_temp.tests_as('c3000000-0000-0000-0000-000000000001');
update public.meeting_speaker_interpretations
set business_role = 'CANDIDATE',
    interpreted_name = 'Corrected Candidate',
    confirmed_by_human = true,
    confirmed_by_membership_id = 'c2000000-0000-0000-0000-000000000001'
where id = 'c7000000-0000-0000-0000-000000000001';

select is(
  (select business_role::text from public.meeting_speaker_interpretations where id = 'c7000000-0000-0000-0000-000000000001'),
  'CANDIDATE',
  'Responsible AM can update/correct speaker interpretation'
);

-- Test 6: Unrelated AM CANNOT UPDATE speaker interpretation
select pg_temp.tests_as('c3000000-0000-0000-0000-000000000003');
update public.meeting_speaker_interpretations
set business_role = 'OTHER'
where id = 'c7000000-0000-0000-0000-000000000001';

reset role;
select is(
  (select business_role::text from public.meeting_speaker_interpretations where id = 'c7000000-0000-0000-0000-000000000001'),
  'CANDIDATE',
  'Unrelated AM update is denied by RLS (role unchanged)'
);

-- Test 7: Cross-org member CANNOT UPDATE speaker interpretation
select pg_temp.tests_as('d3000000-0000-0000-0000-000000000001');
update public.meeting_speaker_interpretations
set business_role = 'OTHER'
where id = 'c7000000-0000-0000-0000-000000000001';

reset role;
select is(
  (select business_role::text from public.meeting_speaker_interpretations where id = 'c7000000-0000-0000-0000-000000000001'),
  'CANDIDATE',
  'Cross-org update is denied by RLS (role unchanged)'
);

-- Test 8: Human correction did NOT alter raw transcript_segments evidence
reset role;
select is(
  (select speaker_label from public.transcript_segments where id = 'c6000000-0000-0000-0000-000000000001'),
  'Speaker 0',
  'Raw transcript segment speaker_label remains completely immutable after human correction'
);

rollback;
