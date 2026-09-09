-- M16 independent review, fixes 2 and 3.
--
-- Fix 2: operational_incidents_open_dedup_uq is real (I manually verified
-- it against the live DB during review), but no committed test ever
-- exercised the constraint itself — only recordIncident's application
-- logic. This proves the DATABASE constraint, independent of any TS code.
--
-- Fix 3: recordIncident's original shape (select existing, then write
-- existing.occurrence_count + 1) could lose an increment under real
-- concurrency. public.record_operational_incident replaces that with a
-- single atomic `insert .. on conflict .. do update set occurrence_count
-- = occurrence_count + 1` statement — atomic because Postgres computes
-- the increment server-side, per-statement, under the row lock the
-- ON CONFLICT check itself takes, not client-side from a stale read.
-- pgTAP runs single-connection/sequential, so it cannot open two real
-- concurrent connections to race this directly — the concurrency
-- guarantee here is structural (a single SQL statement, not two round
-- trips), not something a flaky multi-connection harness would prove any
-- more convincingly. What IS tested here: N sequential calls produce
-- exactly N as the occurrence_count (the arithmetic itself is correct),
-- and that the function is service_role-only (matching the M15 "explicit
-- revoke, not just grant" discipline — also automatically covered by
-- 019_security_definer_privilege_invariant.test.sql's catalog scan,
-- since this is a non-trigger SECURITY DEFINER function).
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

insert into public.organizations (id, name, slug, email_domain)
values ('99400000-0000-0000-0000-000000000001', 'M16 Dedup Test Org', 'm16-dedup-test-org', 'm16dedup.test');

-- ---------------------------------------------------------------------
-- Fix 2: the raw unique index itself rejects a genuine duplicate open row.
-- ---------------------------------------------------------------------
insert into public.operational_incidents (organization_id, queue, entity_id, incident_type, severity, reason)
values ('99400000-0000-0000-0000-000000000001', 'transcription', 'entity-raw-dup', 'stuck', 'warning', 'first');

select throws_ok(
  $$ insert into public.operational_incidents (organization_id, queue, entity_id, incident_type, severity, reason)
     values ('99400000-0000-0000-0000-000000000001', 'transcription', 'entity-raw-dup', 'stuck', 'warning', 'second') $$,
  '23505', null,
  '1. operational_incidents_open_dedup_uq rejects a genuine duplicate open (org, queue, entity, type) row'
);

-- A resolved row with the same key does NOT block a new open one — the
-- index is partial (where resolved_at is null), so this must succeed.
update public.operational_incidents
set resolved_at = now()
where entity_id = 'entity-raw-dup';

select lives_ok(
  $$ insert into public.operational_incidents (organization_id, queue, entity_id, incident_type, severity, reason)
     values ('99400000-0000-0000-0000-000000000001', 'transcription', 'entity-raw-dup', 'stuck', 'warning', 'third') $$,
  '2. a resolved row with the same key does not block a fresh open insert (partial index correctly excludes it)'
);

-- ---------------------------------------------------------------------
-- Fix 3: record_operational_incident is atomic and service_role-only.
-- ---------------------------------------------------------------------
select lives_ok(
  $$ select public.record_operational_incident(
       '99400000-0000-0000-0000-000000000001', 'meeting_bot', 'entity-bump', 'stuck', 'warning', 'first-call', null
     ) $$,
  '3. record_operational_incident runs cleanly for a first call'
);
select public.record_operational_incident('99400000-0000-0000-0000-000000000001', 'meeting_bot', 'entity-bump', 'stuck', 'warning', 'second-call', null);
select public.record_operational_incident('99400000-0000-0000-0000-000000000001', 'meeting_bot', 'entity-bump', 'stuck', 'warning', 'third-call', null);
select public.record_operational_incident('99400000-0000-0000-0000-000000000001', 'meeting_bot', 'entity-bump', 'stuck', 'warning', 'fourth-call', null);

select is(
  (select count(*)::int from public.operational_incidents where entity_id = 'entity-bump'),
  1, '4. four calls for the same open key still produce exactly one row (dedup via the RPC path too, not just raw INSERT)'
);
select is(
  (select occurrence_count from public.operational_incidents where entity_id = 'entity-bump'),
  4, '5. occurrence_count correctly reflects all four calls — no lost increments'
);

set role authenticated;
select throws_ok(
  $$ select public.record_operational_incident('99400000-0000-0000-0000-000000000001', 'meeting_bot', 'entity-x', 'stuck', 'warning', 'x', null) $$,
  '42501', null,
  '6. authenticated cannot call record_operational_incident() directly (service_role-only, matching the M15 explicit-revoke discipline)'
);
reset role;

select * from finish();
rollback;
