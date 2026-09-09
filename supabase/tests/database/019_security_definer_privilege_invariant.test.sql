-- M15 audit: permanent regression guardrail for the systemic pattern
-- behind all four P0s found this session (public.claim_next_calendar_
-- event_job, claim_next_transcription_job, claim_scheduler_call_meeting,
-- complete_transcription_job) — every one was a real, callable, non-
-- trigger SECURITY DEFINER function in the PostgREST-exposed `public`
-- schema that got `grant execute ... to service_role` but never the
-- paired `revoke execute ... from public, anon, authenticated,
-- service_role`, so Postgres's default PUBLIC EXECUTE grant silently
-- stayed in effect for anon/authenticated too.
--
-- This is NOT a hard-coded list of the four functions already found —
-- that would only catch regressions on those exact four. This queries
-- Postgres's own catalog (pg_proc/has_function_privilege) directly, so
-- it automatically covers every SECURITY DEFINER function that exists
-- NOW *and* every one added in the future. A future migration that adds
-- a new SECURITY DEFINER RPC and forgets the revoke will fail THIS test
-- the moment it's added — no code review miss required to catch it.
--
-- The only escape hatch is the tiny, explicit, reviewed allowlist below
-- (§EXPECTED_AUTHENTICATED_CALLABLE) — functions that are GENUINELY
-- meant to be authenticated-callable, each with its own real internal
-- authorization (private.assert_*_authorized + current_organization_id()
-- scoping — see docs/security/m15-security-definer-matrix.md for the
-- full audit of why each one is safe to allowlist). Adding a function to
-- this allowlist must be a deliberate, reviewed decision, never a
-- default.
--
-- Run with: supabase test db --local

begin;
create extension if not exists pgtap with schema extensions;
select plan(3);

-- ---------------------------------------------------------------------
-- 1. THE GUARDRAIL: no non-trigger SECURITY DEFINER function in public
--    is executable by anon or authenticated unless explicitly
--    allowlisted here. Trigger functions are excluded — Postgres
--    structurally blocks direct invocation of a `returns trigger`
--    function outside real trigger context regardless of grants, so
--    their EXECUTE grant state is irrelevant to PostgREST exposure (see
--    the matrix doc, Category A).
-- ---------------------------------------------------------------------
select is_empty(
  $$
  select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef = true
    and p.prorettype::regtype::text <> 'trigger'
    and (
      has_function_privilege('anon', p.oid, 'execute')
      or has_function_privilege('authenticated', p.oid, 'execute')
    )
    and p.proname not in (
      -- EXPECTED_AUTHENTICATED_CALLABLE — reviewed, documented in
      -- docs/security/m15-security-definer-matrix.md Category C. Each
      -- one scopes its target row by organization_id =
      -- private.current_organization_id() THEN calls
      -- private.assert_call_record_authorized(...) or
      -- private.assert_customer_truth_authorized(...) before mutating
      -- anything — the grant is intentionally broad because the REAL
      -- authorization is inside the function body, not the grant.
      'confirm_customer_truth_fact',
      'reject_customer_truth_fact',
      'resolve_call_record',
      'assign_call_record_owner'
    )
  $$,
  '1. No un-allowlisted SECURITY DEFINER function in public is executable by anon/authenticated (catches ALL past and future instances of this session''s P0 pattern, not just the four already found)'
);

-- ---------------------------------------------------------------------
-- 2. The allowlist itself must stay tiny and exact — if this count ever
--    changes, it was a deliberate, reviewed addition (or removal), never
--    silent drift. Bump this number ONLY as part of a PR that also
--    updates the matrix doc and adds this function's own dedicated
--    authorization test (see 012_customer_truth_actions.test.sql for the
--    existing four).
-- ---------------------------------------------------------------------
select is(
  (
    select count(*)::int
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
      and p.prorettype::regtype::text <> 'trigger'
      and p.proname in (
        'confirm_customer_truth_fact',
        'reject_customer_truth_fact',
        'resolve_call_record',
        'assign_call_record_owner'
      )
  ),
  4,
  '2. The authenticated-callable allowlist is exactly the 4 reviewed functions — no silent growth'
);

-- ---------------------------------------------------------------------
-- 3. The mirror-image guardrail the audit's own instructions called
--    out explicitly: don't just check UNAUTHORIZED roles are denied —
--    also verify every KNOWN service-role-only RPC has NOT been
--    accidentally left without service_role access (e.g. a future
--    migration adds the revoke but forgets the grant, or grants the
--    wrong role). If a new service-role-only RPC is added later, add
--    its name to this list in the same PR.
-- ---------------------------------------------------------------------
select is_empty(
  $$
  select p.proname
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef = true
    and p.proname in (
      'claim_next_calendar_event_job',
      'claim_next_transcription_job',
      'claim_scheduler_call_meeting',
      'complete_transcription_job',
      'claim_next_meeting_intelligence_run',
      'complete_meeting_intelligence_run',
      'materialize_customer_truth_deltas'
    )
    and not has_function_privilege('service_role', p.oid, 'execute')
  $$,
  '3. Every known service_role-only RPC remains executable by service_role (a revoke-without-grant regression would fail this)'
);

select * from finish();
rollback;
