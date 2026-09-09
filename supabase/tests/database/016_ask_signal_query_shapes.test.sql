-- M13 Ask Signal regression: retrieveEvidenceBundle (packages/domain/src/
-- ask-signal.ts) queries customer_truth_facts / call_records /
-- transcript_segments DIRECTLY filtered by customer_id (never joined
-- through meetings — Codex M13 Pass 1 SHOULD-FIX #1, to avoid
-- reintroducing the meetings-manager-scope "fragile coincidence" M10
-- already fixed once). M13 adds no new RLS policy — this proves the
-- EXACT query shapes the new code path uses still enforce tenant
-- isolation under the existing policies, not just that the policies
-- exist in the abstract.

begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into public.organizations (id, name, slug, email_domain) values
  ('97000000-0000-0000-0000-00000000000a', 'M13 Test Org P', 'm13-test-org-p', 'm13p.test'),
  ('97000000-0000-0000-0000-00000000000b', 'M13 Test Org Q', 'm13-test-org-q', 'm13q.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '97100000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', 'admin-p@m13test.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '97100000-0000-0000-0000-000000000002', '97000000-0000-0000-0000-00000000000a', 'am-p1@m13test.test', 'AM P1 (owner)', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '97100000-0000-0000-0000-000000000003', '97000000-0000-0000-0000-00000000000a', 'am-p2@m13test.test', 'AM P2 (sibling)', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '97100000-0000-0000-0000-000000000004', '97000000-0000-0000-0000-00000000000b', 'am-q1@m13test.test', 'AM Q1 (cross-org)', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '97100000-0000-0000-0000-000000000005', '97000000-0000-0000-0000-00000000000a', 'manager-p@m13test.test', 'Manager P (reports: AM P1)', id, 'invited'
from public.roles where key = 'manager' and organization_id is null;

-- AM P1 now reports to Manager P, so private.is_manager_of(manager, AM P1)
-- resolves true for the manager-scope RLS check below.
update public.organization_memberships
set manager_membership_id = '97100000-0000-0000-0000-000000000005'
where id = '97100000-0000-0000-0000-000000000002';

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '97200000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@m13test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '97200000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@m13test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '97200000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@m13test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '97200000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'am-q1@m13test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '97200000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'manager-p@m13test.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

-- auth.users insert above auto-links user_id via the on-signup trigger
-- (email match against an 'invited' membership), same as 011's fixtures.

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('97300000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', 'M13 Test Customer', '97100000-0000-0000-0000-000000000002', 'manual');

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status, call_type, customer_id) values
  ('97400000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97100000-0000-0000-0000-000000000002', 'microsoft', 'ical-m13-1', 'M13 Test Meeting', 'teams', 'https://meet.example/m13p1', now() - interval '1 hour', now() - interval '30 minutes', 'record', 'discovery', '97300000-0000-0000-0000-000000000001');

insert into public.meeting_transcripts (id, organization_id, meeting_id, processing_status, detected_language) values
  ('97500000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97400000-0000-0000-0000-000000000001', 'completed', 'en');

insert into public.transcript_segments (id, organization_id, transcript_id, sequence_index, start_ms, end_ms, original_text, original_language, canonical_english_text, needs_review) values
  ('97600000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97500000-0000-0000-0000-000000000001', 0, 0, 4500, 'I want backend roles.', 'en', 'I want backend roles.', false);

insert into public.ai_runs (id, organization_id, meeting_id, transcript_id, model, prompt_version, provider_config_version)
values ('97700000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97400000-0000-0000-0000-000000000001', '97500000-0000-0000-0000-000000000001', 'openai/gpt-4o', 'v1', 'v1');

insert into public.call_records (id, organization_id, meeting_id, customer_id, ai_run_id, record_type, description, owner_type, evidence_segment_ids)
values ('97800000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97400000-0000-0000-0000-000000000001', '97300000-0000-0000-0000-000000000001', '97700000-0000-0000-0000-000000000001', 'action_item', 'Follow up with resume.', 'am', array['97600000-0000-0000-0000-000000000001']::uuid[]);

insert into public.customer_truth_facts (id, organization_id, customer_id, field_key, value, status, source_type, source_meeting_id, evidence_segment_ids)
values ('97900000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-00000000000a', '97300000-0000-0000-0000-000000000001', 'target_roles', '"Backend"'::jsonb, 'confirmed', 'meeting', '97400000-0000-0000-0000-000000000001', array['97600000-0000-0000-0000-000000000001']::uuid[]);

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- Owner AM (P1): the exact retrieveEvidenceBundle query shapes all
-- return the row.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('97200000-0000-0000-0000-000000000002');

select is(
  (select count(*)::int from public.customer_truth_facts where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Owner AM: customer_truth_facts.eq(customer_id) returns the row'
);
select is(
  (select count(*)::int from public.call_records where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Owner AM: call_records.eq(customer_id) returns the row (direct, not joined through meetings)'
);
select is(
  (select count(*)::int from public.transcript_segments where id = '97600000-0000-0000-0000-000000000001'),
  1, 'Owner AM: transcript_segments.in(evidence_segment_ids) returns the hydrated segment'
);

-- ---------------------------------------------------------------------
-- Sibling AM (P2): same org, does NOT own this customer/meeting, no
-- manager permission — must see nothing via any of the three shapes.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('97200000-0000-0000-0000-000000000003');

select is(
  (select count(*)::int from public.customer_truth_facts where customer_id = '97300000-0000-0000-0000-000000000001'),
  0, 'Sibling AM: customer_truth_facts invisible'
);
select is(
  (select count(*)::int from public.call_records where customer_id = '97300000-0000-0000-0000-000000000001'),
  0, 'Sibling AM: call_records invisible'
);
select is(
  (select count(*)::int from public.transcript_segments where id = '97600000-0000-0000-0000-000000000001'),
  0, 'Sibling AM: transcript_segments invisible'
);

-- ---------------------------------------------------------------------
-- Cross-org AM (Q1): must see nothing.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('97200000-0000-0000-0000-000000000004');

select is(
  (select count(*)::int from public.customer_truth_facts where customer_id = '97300000-0000-0000-0000-000000000001'),
  0, 'Cross-org AM: customer_truth_facts invisible'
);
select is(
  (select count(*)::int from public.call_records where customer_id = '97300000-0000-0000-0000-000000000001'),
  0, 'Cross-org AM: call_records invisible'
);

-- ---------------------------------------------------------------------
-- Reporting manager (manages AM P1, the customer's owner): must see the
-- exact same retrieveEvidenceBundle query shapes as the owner, via the
-- manager-scope policies (private.has_permission('intelligence.read')
-- and private.is_manager_of(...)), which the 'manager' role grants by
-- default.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('97200000-0000-0000-0000-000000000005');

select is(
  (select count(*)::int from public.customer_truth_facts where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Reporting manager: customer_truth_facts visible via manager scope'
);
select is(
  (select count(*)::int from public.call_records where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Reporting manager: call_records visible via manager scope'
);

-- ---------------------------------------------------------------------
-- Org admin: org-wide visibility.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('97200000-0000-0000-0000-000000000001');

select is(
  (select count(*)::int from public.customer_truth_facts where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Org admin: customer_truth_facts visible org-wide'
);
select is(
  (select count(*)::int from public.call_records where customer_id = '97300000-0000-0000-0000-000000000001'),
  1, 'Org admin: call_records visible org-wide'
);

select * from finish();
rollback;
