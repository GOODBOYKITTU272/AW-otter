-- M9 correction #1 (deferred customer_truth materialization) + #5
-- (customer_truth safety enforced at the DB/RPC boundary, not convention).
--
-- customer_truth_facts already exists (M7A, 20260908040001) with exactly
-- the columns this needs (source_type='meeting', source_meeting_id,
-- source_speaker, evidence_segment_ids) — reserved then, unused until now.
-- No schema change to that table. Its existing RLS
-- (customer_truth_facts_insert_manual_seed) is untouched — it only ever
-- permits authenticated 'manual'/'onboarding_form' confirmed inserts, and
-- stays that way. The ONLY new write path is this SECURITY DEFINER RPC,
-- granted EXECUTE to service_role alone, which hard-codes status='proposed'
-- — there is no parameter that could ever write 'confirmed'. "M9 may
-- propose, M9 must never confirm" is enforced by the function signature
-- itself, not by application discipline.

create or replace function public.validate_customer_truth_evidence_segments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_valid_count int;
begin
  if new.evidence_segment_ids is null or new.source_meeting_id is null then
    return new;
  end if;

  select count(*) into v_valid_count
  from public.transcript_segments ts
  join public.meeting_transcripts mt on mt.id = ts.transcript_id
  where ts.id = any(new.evidence_segment_ids)
    and mt.meeting_id = new.source_meeting_id;

  if v_valid_count <> coalesce(array_length(new.evidence_segment_ids, 1), 0) then
    raise exception 'customer_truth_facts.evidence_segment_ids must all belong to a transcript segment of source_meeting_id.';
  end if;
  return new;
end;
$$;

create trigger customer_truth_facts_validate_evidence
  before insert or update on public.customer_truth_facts
  for each row execute function public.validate_customer_truth_evidence_segments();

-- Idempotent by design: safe to call redundantly (immediately after a run
-- completes, AND from a periodic sweep once linkage resolves later) — it
-- no-ops (returns false) if already materialized, if the run isn't
-- completed, or if the meeting still has no customer_id. Never requires a
-- second AI call: it reads deltas straight out of ai_runs.validated_output,
-- which complete_meeting_intelligence_run already persisted in full.
--
-- Known, accepted limitation: if a meeting's customer_id is later
-- corrected to a DIFFERENT customer after materialization already ran
-- against the original one, already-materialized facts are not
-- retracted/reassigned — that is a rare, audited manual data-correction
-- scenario (M7A's own linkMeetingToCustomer), out of scope here.
create or replace function public.materialize_customer_truth_deltas(
  p_run_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.ai_run_status;
  v_meeting_id uuid;
  v_materialized_at timestamptz;
  v_validated_output jsonb;
  v_customer_id uuid;
begin
  select status, meeting_id, customer_truth_materialized_at, validated_output
    into v_status, v_meeting_id, v_materialized_at, v_validated_output
    from public.ai_runs
    where id = p_run_id and organization_id = p_organization_id
    for update;

  if v_status is null or v_status <> 'completed' or v_materialized_at is not null then
    return false;
  end if;

  select customer_id into v_customer_id
    from public.meetings
    where id = v_meeting_id and organization_id = p_organization_id;

  if v_customer_id is null then
    return false; -- still needs_link / unlinked — nothing to materialize yet
  end if;

  insert into public.customer_truth_facts (
    organization_id, customer_id, field_key, value, status,
    source_type, source_meeting_id, evidence_segment_ids, detected_at
  )
  select
    p_organization_id,
    v_customer_id,
    delta ->> 'fieldKey',
    delta -> 'proposedValue',
    'proposed',
    'meeting',
    v_meeting_id,
    array(select jsonb_array_elements_text(delta -> 'evidenceSegmentIds'))::uuid[],
    now()
  from jsonb_array_elements(coalesce(v_validated_output -> 'customerTruthDeltas', '[]'::jsonb)) as delta;

  update public.ai_runs
  set customer_truth_materialized_at = now()
  where id = p_run_id and organization_id = p_organization_id;

  return true;
end;
$$;

-- Explicitly named roles, not just `public` — see the note on
-- claim_next_meeting_intelligence_run's own revoke (20260908070001) for
-- why `from public` alone was not sufficient against a real CI Postgres
-- image patch difference.
revoke execute on function public.materialize_customer_truth_deltas(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.materialize_customer_truth_deltas(uuid, uuid) to service_role;
