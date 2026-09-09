-- M15 security audit (P0 finding, fixed in
-- 20260911150001_revoke_calendar_event_job_public_execute.sql):
-- public.claim_next_calendar_event_job() (M4) was missing the explicit
-- named-role EXECUTE revoke every other SECURITY DEFINER RPC in this
-- schema has — Postgres's default PUBLIC execute grant on function
-- creation meant `anon`/`authenticated` could genuinely call it directly
-- over PostgREST (confirmed exploitable against the real local database
-- before the fix: it dequeued and mutated the oldest pending
-- calendar_event_jobs row ACROSS EVERY ORGANIZATION, bypassing that
-- table's own deliberately zero-grant RLS). No fixtures needed — this is
-- a pure role-privilege check, not a row-visibility check. Run with:
-- supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

set role authenticated;
select throws_ok(
  $$ select public.claim_next_calendar_event_job() $$,
  '42501', null,
  '1a. authenticated cannot call claim_next_calendar_event_job() — the M4-era gap is closed'
);

reset role;
set role anon;
select throws_ok(
  $$ select public.claim_next_calendar_event_job() $$,
  '42501', null,
  '2a. anon cannot call claim_next_calendar_event_job() — the M4-era gap is closed'
);

reset role;
set role service_role;
select lives_ok(
  $$ select public.claim_next_calendar_event_job() $$,
  '3a. service_role (the intended caller) can still call claim_next_calendar_event_job()'
);
reset role;

select * from finish();
rollback;
