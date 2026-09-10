-- Plan A Database Invariant Tests
-- Proves:
-- 1. AM visibility (own meeting)
-- 2. Manager visibility (via is_manager_of + exceptions.approve)
-- 3. Cross-org isolation (Org B cannot see Org A recaps or integrity data)
-- 4. Revisions append-only enforcement (UPDATE/DELETE blocked)
-- 5. Org consistency trigger enforcement
-- 6. Status check constraint (draft/ready_for_review/approved, no 'sent')

begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Setup test orgs
insert into public.organizations (id, name, slug, email_domain) values
  ('a1000000-0000-0000-0000-000000000001', 'Signal Test Org A', 'signal-test-org-a', 'signal-a.test'),
  ('b1000000-0000-0000-0000-000000000002', 'Signal Test Org B', 'signal-test-org-b', 'signal-b.test');

-- Manager A (manager of AM A)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'a2000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'manager@signal-a.test', 'Manager A', id, 'active'
from public.roles where key = 'manager' and organization_id is null;

-- AM A (owner of meeting, reports to Manager A)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, manager_membership_id, status)
select 'a2000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'am@signal-a.test', 'AM A', id, 'a2000000-0000-0000-0000-000000000002', 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- AM B (Org B member)
insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select 'b2000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000002', 'am@signal-b.test', 'AM B', id, 'active'
from public.roles where key = 'account_manager' and organization_id is null;

-- Auth users
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin) values
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'a3000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'manager@signal-a.test', '', now(), now(), now(), '{}', '{}', false),
  ('00000000-0000-0000-0000-000000000000', 'b3000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'am@signal-b.test', '', now(), now(), now(), '{}', '{}', false);

-- Link memberships to users
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000001' where id = 'a2000000-0000-0000-0000-000000000001';
update public.organization_memberships set user_id = 'a3000000-0000-0000-0000-000000000002' where id = 'a2000000-0000-0000-0000-000000000002';
update public.organization_memberships set user_id = 'b3000000-0000-0000-0000-000000000001' where id = 'b2000000-0000-0000-0000-000000000001';

-- Create meetings owned by AM A
insert into public.meetings (id, organization_id, owner_membership_id, provider, title, ical_uid, organizer_email, scheduled_start, scheduled_end, lifecycle_status, eligibility_status)
values
  ('a4000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'microsoft', 'Signal Plan A Test Call 1', 'sig-test-01', 'am@signal-a.test', now(), now() + interval '30 minutes', 'upcoming', 'record'),
  ('a4000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'microsoft', 'Signal Plan A Test Call 2', 'sig-test-02', 'am@signal-a.test', now(), now() + interval '30 minutes', 'upcoming', 'record'),
  ('a4000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'a2000000-0000-0000-0000-000000000001', 'microsoft', 'Signal Plan A Test Call 3', 'sig-test-03', 'am@signal-a.test', now(), now() + interval '30 minutes', 'upcoming', 'record');

-- Create recap, revision, integrity report, and integrity flag
insert into public.meeting_recaps (id, organization_id, meeting_id, status)
values ('a5000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'draft');

insert into public.meeting_recap_revisions (id, organization_id, recap_id, revision_number, created_by_membership_id, greeting, agreements, actions, next_step, revision_reason)
values ('a6000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a5000000-0000-0000-0000-000000000001', 1, 'a2000000-0000-0000-0000-000000000001', 'Hello Student', '["agreed 1"]'::jsonb, '["action 1"]'::jsonb, 'Next step soon', 'initial_derivation');

insert into public.meeting_integrity_reports (id, organization_id, meeting_id, overall_verdict, summary, metrics)
values ('a7000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000001', 'review_recommended', 'Integrity review needed', '{"confidence_avg": 0.82}'::jsonb);

insert into public.meeting_integrity_flags (id, organization_id, report_id, flag_type, severity, start_ms, end_ms, reason_code, message)
values ('a8000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'a7000000-0000-0000-0000-000000000001', 'low_confidence', 'warning', 1000, 5000, 'low_confidence', 'Whisper confidence below threshold');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- 1, 2, 3: AM A sees recap, revision, and flag
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_recaps where id = 'a5000000-0000-0000-0000-000000000001'),
  1, '1. AM owner sees own meeting recap'
);
select is(
  (select count(*)::int from public.meeting_recap_revisions where id = 'a6000000-0000-0000-0000-000000000001'),
  1, '2. AM owner sees meeting recap revision'
);
select is(
  (select count(*)::int from public.meeting_integrity_flags where id = 'a8000000-0000-0000-0000-000000000001'),
  1, '3. AM owner sees meeting integrity flag'
);

-- 4 & 5: Manager A sees recap and report in their reporting tree
reset role;
select pg_temp.tests_as('a3000000-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.meeting_recaps where id = 'a5000000-0000-0000-0000-000000000001'),
  1, '4. Reporting manager sees direct report meeting recap'
);
select is(
  (select overall_verdict from public.meeting_integrity_reports where id = 'a7000000-0000-0000-0000-000000000001'),
  'review_recommended', '5. Reporting manager sees direct report integrity report verdict'
);

-- 6 & 7: Org B AM cannot see Org A recap or integrity reports
reset role;
select pg_temp.tests_as('b3000000-0000-0000-0000-000000000001');
select is(
  (select count(*)::int from public.meeting_recaps where id = 'a5000000-0000-0000-0000-000000000001'),
  0, '6. Cross-org member cannot see Org A meeting recap'
);
select is(
  (select count(*)::int from public.meeting_integrity_reports where id = 'a7000000-0000-0000-0000-000000000001'),
  0, '7. Cross-org member cannot see Org A integrity report'
);

-- 8 & 9: Append-only revisions: UPDATE or DELETE is rejected
reset role;
select throws_ok(
  $$update public.meeting_recap_revisions set greeting = 'Changed' where id = 'a6000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'meeting_recap_revisions is append-only and cannot be updated or deleted.',
  '8. Updating a meeting recap revision is blocked by append-only trigger'
);
select throws_ok(
  $$delete from public.meeting_recap_revisions where id = 'a6000000-0000-0000-0000-000000000001'$$,
  'P0001',
  'meeting_recap_revisions is append-only and cannot be updated or deleted.',
  '9. Deleting a meeting recap revision is blocked by append-only trigger'
);

-- 10: Org mismatch prevention: attaching recap to meeting in different org is blocked
select throws_ok(
  $$insert into public.meeting_recaps (organization_id, meeting_id, status)
    values ('b1000000-0000-0000-0000-000000000002', 'a4000000-0000-0000-0000-000000000001', 'draft')$$,
  'P0001',
  'meeting_recaps.meeting_id must belong to the same organization.',
  '10. Org mismatch between recap and meeting is blocked by trigger'
);

-- 11: Invalid status ('sent') rejected by check constraint
select throws_ok(
  $$insert into public.meeting_recaps (organization_id, meeting_id, status)
    values ('a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000002', 'sent')$$,
  '23514',
  null,
  '11. Status "sent" is rejected by check constraint (Plan A has no sent status)'
);

-- 12: Status 'approved' requires approved_by_membership_id and approved_at
select throws_ok(
  $$insert into public.meeting_recaps (organization_id, meeting_id, status)
    values ('a1000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000003', 'approved')$$,
  '23514',
  null,
  '12. Status "approved" without approved_by_membership_id or approved_at is rejected'
);

select finish();
rollback;
