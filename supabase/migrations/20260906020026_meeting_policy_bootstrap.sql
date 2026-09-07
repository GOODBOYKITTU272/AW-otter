-- Every organization needs exactly one meeting_policy_sets row (the
-- unique index on organization_id already enforces "at most one" — this
-- trigger guarantees "at least one", same bootstrapping idiom as
-- handle_new_user for profiles). Fires for both pre-existing seed
-- organizations (seed.sql runs after all migrations, so this trigger is
-- already installed by the time it inserts organizations) and any future
-- one, so there is never a manual backfill step.
create or replace function public.bootstrap_meeting_policy_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_policy_set_id uuid;
begin
  insert into public.meeting_policy_sets (organization_id)
  values (new.id)
  returning id into v_policy_set_id;

  -- Fixed nine rule_types, seeded enabled except role_team (inert in V1 —
  -- no team-selection data exists yet to evaluate against, see
  -- 20260906020023's comment). admin_exclusion is seeded for schema
  -- completeness per the locked blueprint but the evaluation engine never
  -- checks it directly in V1 — approved_exemption is the one real
  -- exclusion mechanism (see the M5 design decision merging blueprint
  -- priorities #11/#12).
  insert into public.meeting_policy_rules (policy_set_id, rule_type, enabled, reason_code) values
    (v_policy_set_id, 'organization_disabled', true, 'Organization is not active'),
    (v_policy_set_id, 'employee_mi_disabled', true, 'Meeting Intelligence is disabled for this employee'),
    (v_policy_set_id, 'unsupported_mechanism', true, 'Meeting is not a supported Teams meeting'),
    (v_policy_set_id, 'admin_exclusion', true, 'Excluded by an administrator'),
    (v_policy_set_id, 'approved_exemption', true, 'An approved do-not-record request applies to this meeting'),
    (v_policy_set_id, 'sensitive_internal', false, 'Meeting is internal-only'),
    (v_policy_set_id, 'role_team', false, 'Excluded by role/team policy'),
    (v_policy_set_id, 'external_client', false, 'Meeting includes an external participant'),
    (v_policy_set_id, 'org_default', true, 'Organization default policy applied');

  return new;
end;
$$;

create trigger organizations_bootstrap_meeting_policy_set
  after insert on public.organizations
  for each row execute function public.bootstrap_meeting_policy_set();

-- Needed for real: resolveCutoffExceptions / cancelExceptionsForCancelledMeetings
-- run as service_role (no authenticated human caller — they're triggered
-- by an internal route, same pattern as M4's reconciliation) but "every
-- action audited" is an explicit M5 requirement, including cutoff/default
-- resolution. audit_events previously only granted INSERT to authenticated
-- (M3) — this is a deliberate, new, narrow addition: service_role gets
-- INSERT only (never SELECT/UPDATE/DELETE), and actor_id is null for
-- these system-triggered rows (audit_events.actor_id is nullable).
grant insert on public.audit_events to service_role;
