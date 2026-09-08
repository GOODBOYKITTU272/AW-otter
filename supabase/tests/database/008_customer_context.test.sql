-- M7A customers / customer_contacts / customer_truth_facts test matrix.
-- Self-contained fixtures, rolled back at the end.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- ---------------------------------------------------------------------
-- Fixtures: two orgs. Org P has admin/manager/AM1/AM2 (siblings, same
-- manager) so we can test AM-own vs sibling-AM vs admin vs cross-org.
-- ---------------------------------------------------------------------

insert into public.organizations (id, name, slug, email_domain) values
  ('19000000-0000-0000-0000-00000000000a', 'M7A Test Org P', 'm7a-test-org-p', 'orgp.test'),
  ('19000000-0000-0000-0000-00000000000b', 'M7A Test Org Q', 'm7a-test-org-q', 'orgq.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '42000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-00000000000a', 'admin-p@pgtap.test', 'Admin P', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '42000000-0000-0000-0000-000000000002', '19000000-0000-0000-0000-00000000000a', 'am-p1@pgtap.test', 'AM P1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '42000000-0000-0000-0000-000000000003', '19000000-0000-0000-0000-00000000000a', 'am-p2@pgtap.test', 'AM P2', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '42000000-0000-0000-0000-000000000004', '19000000-0000-0000-0000-00000000000b', 'admin-q@pgtap.test', 'Admin Q', id, 'invited'
from public.roles where key = 'admin' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '42000000-0000-0000-0000-000000000005', '19000000-0000-0000-0000-00000000000b', 'am-q1@pgtap.test', 'AM Q1', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000', '43000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'admin-p@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '43000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'am-p1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '43000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'am-p2@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '43000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'admin-q@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '43000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'am-q1@pgtap.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

insert into public.customers (id, organization_id, name, owner_membership_id, source_type) values
  ('44000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-00000000000a', 'Customer P1', '42000000-0000-0000-0000-000000000002', 'manual');

insert into public.customer_contacts (id, organization_id, customer_id, email) values
  ('45000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'contact-p1@client.test');

insert into public.customer_truth_facts (id, organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at) values
  ('46000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'target_roles', '"backend"', 'confirmed', 'manual', '42000000-0000-0000-0000-000000000002', now());

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
-- 1. Anon denied everywhere.
-- ---------------------------------------------------------------------
select pg_temp.tests_as_anon();

select throws_ok($$ select count(*) from public.customers $$, '42501', null, '1a. Anon cannot select customers');
select throws_ok($$ select count(*) from public.customer_contacts $$, '42501', null, '1b. Anon cannot select customer_contacts');
select throws_ok($$ select count(*) from public.customer_truth_facts $$, '42501', null, '1c. Anon cannot select customer_truth_facts');
select throws_ok($$ select count(*) from public.customer_truth_current $$, '42501', null, '1d. Anon cannot select customer_truth_current');

-- ---------------------------------------------------------------------
-- 2. customers visibility: own, sibling denied, admin org-wide, cross-org denied.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1, owns the customer

select is(
  (select name from public.customers where id = '44000000-0000-0000-0000-000000000001'),
  'Customer P1',
  '2a. The owning AM can see their own customer'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000003'); -- AM P2, sibling, doesn't own this customer

select is(
  (select count(*)::int from public.customers where id = '44000000-0000-0000-0000-000000000001'),
  0,
  '2b. A sibling AM who doesn''t own the customer cannot see it'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000001'); -- Admin P

select is(
  (select name from public.customers where id = '44000000-0000-0000-0000-000000000001'),
  'Customer P1',
  '2c. Org admin can see the customer org-wide'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000004'); -- Admin Q, cross-org

select is(
  (select count(*)::int from public.customers where id = '44000000-0000-0000-0000-000000000001'),
  0,
  '2d. Cross-org admin cannot see the customer'
);

-- ---------------------------------------------------------------------
-- 3. customer_contacts / customer_truth_facts visibility mirrors the
--    parent customer, including through the customer_truth_current view.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('43000000-0000-0000-0000-000000000003'); -- AM P2, sibling

select is(
  (select count(*)::int from public.customer_contacts where id = '45000000-0000-0000-0000-000000000001'),
  0,
  '3a. A sibling AM cannot see another AM''s customer contact'
);

select is(
  (select count(*)::int from public.customer_truth_facts where id = '46000000-0000-0000-0000-000000000001'),
  0,
  '3b. A sibling AM cannot see another AM''s customer truth fact'
);

select is(
  (select count(*)::int from public.customer_truth_current where customer_id = '44000000-0000-0000-0000-000000000001'),
  0,
  '3c. customer_truth_current respects the same RLS as the base table (security_invoker)'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1, owner

select is(
  (select email::text from public.customer_contacts where id = '45000000-0000-0000-0000-000000000001'),
  'contact-p1@client.test',
  '3d. The owning AM can see their customer''s contact'
);

select is(
  (select value::text from public.customer_truth_current where customer_id = '44000000-0000-0000-0000-000000000001' and field_key = 'target_roles'),
  '"backend"',
  '3e. The owning AM can read the current Customer Truth value via the view'
);

-- ---------------------------------------------------------------------
-- 4. customers insert: own-org + source_type='manual' + self-or-admin owner.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Self-created customer', '42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000002', 'manual') $$,
  '4a. An AM can create a customer they own themselves'
);

select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Wrong owner', '42000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000002', 'manual') $$,
  '42501', null, '4b. An AM cannot create a customer owned by a different AM'
);

select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Not manual', '42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000002', 'fixture') $$,
  '42501', null, '4c. An authenticated caller cannot insert source_type other than manual'
);

select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Forged creator', '42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000003', 'manual') $$,
  '42501', null, '4c2. created_by_membership_id must be the caller''s own membership, not someone else''s'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000001'); -- Admin P

-- Since the created_by_membership_id RLS check (added after Codex's
-- post-implementation review) requires it to equal the caller's own
-- membership, and Admin P's own membership can only ever belong to org P,
-- this specific cross-org attempt is now caught by the
-- validate_customer_org_consistency TRIGGER (created_by vs organization_id
-- mismatch) before RLS's own organization_id check would even run —
-- both layers reject it, the trigger just wins the race here. Still a
-- correct, defense-in-depth rejection either way.
select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000b', 'Cross-org', '42000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000001', 'manual') $$,
  'P0001', null, '4d. An admin cannot insert a customer into a DIFFERENT organization, even with a same-target-org owner'
);

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Admin-created for AM P2', '42000000-0000-0000-0000-000000000003', '42000000-0000-0000-0000-000000000001', 'manual') $$,
  '4e. An Admin can create a customer owned by any AM in their own org'
);

select throws_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, created_by_membership_id, source_type)
     values ('19000000-0000-0000-0000-00000000000a', 'Cross-org owner', '42000000-0000-0000-0000-000000000005', '42000000-0000-0000-0000-000000000001', 'manual') $$,
  'P0001', null, '4f. Org-consistency trigger rejects an owner_membership_id from a different organization even when organization_id itself is correct'
);

-- ---------------------------------------------------------------------
-- 5. customer_contacts: uniqueness + insert requires owning the parent.
-- ---------------------------------------------------------------------
reset role;

select throws_ok(
  $$ insert into public.customer_contacts (organization_id, customer_id, email) values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'contact-p1@client.test') $$,
  '23505', null, '5a. (organization_id, email) must be unique — a duplicate contact email in the same org is rejected'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1, owns the customer

select lives_ok(
  $$ insert into public.customer_contacts (organization_id, customer_id, email) values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'contact-p1b@client.test') $$,
  '5b. The owning AM can add a contact to their own customer'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000003'); -- AM P2, sibling

select throws_ok(
  $$ insert into public.customer_contacts (organization_id, customer_id, email) values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'contact-p1c@client.test') $$,
  '42501', null, '5c. A sibling AM cannot add a contact to a customer they don''t own'
);

-- ---------------------------------------------------------------------
-- 6. customer_truth_facts insert WITH CHECK — the M7A contract is
--    DB-enforced, not just a route-level promise (Codex plan review
--    BLOCKING #2).
-- ---------------------------------------------------------------------
select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1, owns the customer

select lives_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'manual', '42000000-0000-0000-0000-000000000002', now()) $$,
  '6a. A manual, self-confirmed seed fact is allowed'
);

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'crm', '42000000-0000-0000-0000-000000000002', now()) $$,
  '42501', null, '6b. source_type=crm is rejected for an authenticated insert (not reachable until M7B)'
);

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'meeting', '42000000-0000-0000-0000-000000000002', now()) $$,
  '42501', null, '6c. source_type=meeting is rejected for an authenticated insert (no AI-detected path exists yet)'
);

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'proposed', 'manual', '42000000-0000-0000-0000-000000000002', now()) $$,
  '42501', null, '6d. status=proposed is rejected for an authenticated insert — manual seed facts must be confirmed at ingestion, never left proposed'
);

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'manual', '42000000-0000-0000-0000-000000000003', now()) $$,
  '42501', null, '6e. confirmed_by_membership_id must be the caller''s own membership, not someone else''s'
);

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at, evidence_segment_ids)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'manual', '42000000-0000-0000-0000-000000000002', now(), array['46000000-0000-0000-0000-000000000001'::uuid]) $$,
  '42501', null, '6f. evidence_segment_ids must be null for a manual seed fact (no transcript exists to anchor to)'
);

select pg_temp.tests_as('43000000-0000-0000-0000-000000000003'); -- AM P2, sibling

select throws_ok(
  $$ insert into public.customer_truth_facts (organization_id, customer_id, field_key, value, status, source_type, confirmed_by_membership_id, confirmed_at)
     values ('19000000-0000-0000-0000-00000000000a', '44000000-0000-0000-0000-000000000001', 'locations', '["remote"]', 'confirmed', 'manual', '42000000-0000-0000-0000-000000000003', now()) $$,
  '42501', null, '6g. A sibling AM cannot seed a Customer Truth fact for a customer they don''t own'
);

-- ---------------------------------------------------------------------
-- 7. No authenticated update/delete on any of the three tables in M7A.
-- ---------------------------------------------------------------------
select pg_temp.tests_as('43000000-0000-0000-0000-000000000002'); -- AM P1, owner

select throws_ok(
  $$ update public.customers set name = 'Renamed' where id = '44000000-0000-0000-0000-000000000001' $$,
  '42501', null, '7a. No authenticated role can update customers directly (no grant at all)'
);

select throws_ok(
  $$ update public.customer_truth_facts set status = 'rejected' where id = '46000000-0000-0000-0000-000000000001' $$,
  '42501', null, '7b. No authenticated role can update customer_truth_facts directly — mutation is append-only via new rows, never in place'
);

-- ---------------------------------------------------------------------
-- 8. meetings.customer_id org-consistency trigger + forward-compatible
--    columns (external_crm_id / customer linkage columns stay nullable).
-- ---------------------------------------------------------------------
reset role;

insert into public.meetings (id, organization_id, owner_membership_id, provider, ical_uid, title, meeting_type, meeting_url, scheduled_start, scheduled_end, eligibility_status) values
  ('47000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-00000000000a', '42000000-0000-0000-0000-000000000002', 'microsoft', 'ical-m7a-1', 'M7A Test Meeting', 'teams', 'https://meet.example/m7a1', now() + interval '1 hour', now() + interval '2 hours', 'record');

select lives_ok(
  $$ update public.meetings set customer_id = '44000000-0000-0000-0000-000000000001', customer_link_status = 'linked_auto' where id = '47000000-0000-0000-0000-000000000001' $$,
  '8a. Linking a meeting to a same-org customer succeeds'
);

insert into public.customers (id, organization_id, name, owner_membership_id, source_type)
values ('44000000-0000-0000-0000-00000000000b', '19000000-0000-0000-0000-00000000000b', 'Customer Q1', '42000000-0000-0000-0000-000000000005', 'manual');

select throws_ok(
  $$ update public.meetings set customer_id = '44000000-0000-0000-0000-00000000000b' where id = '47000000-0000-0000-0000-000000000001' $$,
  'P0001', null, '8b. meetings.customer_id must belong to the same organization as the meeting (org-consistency trigger)'
);

select lives_ok(
  $$ insert into public.customers (organization_id, name, owner_membership_id, source_type, external_crm_id)
     values ('19000000-0000-0000-0000-00000000000a', 'Forward-compat customer', '42000000-0000-0000-0000-000000000002', 'manual', null) $$,
  '8c. external_crm_id accepts NULL today (M7A never sets it)'
);

select lives_ok(
  $$ update public.customers set external_crm_id = 'future-crm-id-123' where name = 'Forward-compat customer' $$,
  '8d. external_crm_id accepts a real value too — the column is forward-compatible with M7B''s backfill, not a text-only placeholder'
);

select * from finish();
rollback;
