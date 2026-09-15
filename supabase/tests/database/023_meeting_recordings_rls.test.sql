-- Confirms meeting_recordings_select_meeting_visible correctly composes
-- with meetings' own RLS (same-org visible member can see it, cross-org
-- member cannot), and that the (organization_id, meeting_id) uniqueness
-- constraint is real and enforced.

begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into public.organizations (id, name, slug, email_domain) values
  ('98000000-0000-0000-0000-0000000000c1', 'M17C Recordings Test Org A', 'm17c-rec-org-a', 'm17crecA.test'),
  ('98000000-0000-0000-0000-0000000000c2', 'M17C Recordings Test Org B', 'm17c-rec-org-b', 'm17crecB.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', 'am-a@m17crecA.test', 'AM Org A', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-0000000000c2', '98000000-0000-0000-0000-0000000000c2', 'am-b@m17crecB.test', 'AM Org B', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) values
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'am-a@m17crecA.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'am-b@m17crecB.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

-- meetings row owned by Org A, minimal required fields per the REAL,
-- CURRENT public.meetings schema (the original M4 migration
-- 20260906020017_meeting_tables.sql has since been altered by later
-- migrations: external_event_id was replaced by ical_uid (not null, no
-- default) plus organizer_email/organizer_name; eligibility_status is now
-- the meeting_eligibility enum, not free text — confirmed live via
-- `\d public.meetings` during test-writing, not assumed from the original
-- migration file). owner_membership_id is set to the Org A AM's own
-- membership so meetings_select_own actually grants them visibility
-- (meetings RLS has no "any org member sees any org meeting" policy —
-- visibility is ownership/admin/manager-scoped, same as 010_transcription
-- test's fixture shape).
insert into public.meetings (id, organization_id, owner_membership_id, provider, title, ical_uid, organizer_email, scheduled_start, scheduled_end, lifecycle_status, eligibility_status)
values ('98300000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', '98100000-0000-0000-0000-0000000000c1', 'microsoft', 'Recording RLS Test Meeting', 'rls-test-uid-c1', 'am-a@m17crecA.test', now(), now() + interval '30 minutes', 'upcoming', 'record');

insert into public.meeting_recordings (id, organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, source_provider)
values ('98400000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', '98300000-0000-0000-0000-0000000000c1', 'audio', 'meeting-recordings', 'organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/audio.original.webm', 'audio/webm', 12345, 'vexa');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- 1: Org A member sees the row.
select pg_temp.tests_as('98200000-0000-0000-0000-0000000000c1');
select is(
  (select count(*)::int from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  1, '1. Same-org member sees the meeting_recordings row via meeting_recordings_select_meeting_visible'
);
select is(
  (select storage_path from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  'organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/audio.original.webm',
  '2. Same-org member sees the real storage_path (not filtered/redacted)'
);

-- 3: Org B member (cross-org) does NOT see it.
reset role;
select pg_temp.tests_as('98200000-0000-0000-0000-0000000000c2');
select is(
  (select count(*)::int from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  0, '3. Cross-org member cannot see the recording row'
);

reset role;

-- 4: uniqueness constraint is real (same media_kind).
select throws_ok(
  $$insert into public.meeting_recordings (organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, source_provider)
    values ('98000000-0000-0000-0000-0000000000c1', '98300000-0000-0000-0000-0000000000c1', 'audio', 'meeting-recordings', 'organizations/x/meetings/y/audio.original.webm', 'audio/webm', 1, 'vexa')$$,
  '23505',
  null,
  '4. A second recording row for the same meeting_id and media_kind is rejected by the unique constraint'
);

-- 5: byte_size must be positive.
select throws_ok(
  $$insert into public.meeting_recordings (organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, source_provider)
    values ('98000000-0000-0000-0000-0000000000c2', '98300000-0000-0000-0000-0000000000c1', 'video', 'meeting-recordings', 'organizations/x/meetings/z/video.original.mp4', 'video/mp4', 0, 'vexa')$$,
  '23514',
  null,
  '5. byte_size <= 0 is rejected by the check constraint'
);

select finish();
rollback;
