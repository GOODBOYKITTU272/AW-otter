-- M9: Customer Call Intelligence Engine. Locked design:
-- docs/product/Signal_Post_M6_Redesign_v2.md §5/§8/§9, corrected per the
-- "M9 CORRECTIONS" review (evidence-grade ai_runs, deterministic identity
-- for idempotency, explicit summary field, customer_truth safety enforced
-- at the RPC boundary — see each section below for the specific fix).
--
-- ai_runs IS the job row (processing_status doubles as worker-queue state),
-- same convention meeting_transcripts (M8) established. One row per
-- deterministic identity tuple (meeting_id, transcript_id, run_type, model,
-- prompt_version, provider_config_version) — a worker retry after a crash
-- reuses the SAME row via the retryable/next_retry_at state machine, it
-- never creates a duplicate; a deliberate model/prompt change is a
-- genuinely different identity, which creates a new row and preserves the
-- old one (M9 correction #2: idempotency must not depend on the model).

create type public.ai_run_status as enum (
  'pending',
  'running',
  'completed',
  'failed',
  'retryable'
);

create type public.call_record_type as enum (
  'action_item',
  'commitment',
  'decision',
  'question',
  'blocker'
);

create type public.call_record_owner_type as enum (
  'customer',
  'am',
  'resume_team',
  'applywizz',
  'other'
);

-- Shared enum across all five record_types (redesign doc §9) — a
-- particular record_type only ever occupies a subset of these values; the
-- actual state-machine transitions are M10's concern, not enforced here.
-- M9 only ever writes 'detected'.
create type public.call_record_status as enum (
  'detected',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'superseded',
  'answered',
  'closed',
  'resolved'
);

-- M9 correction #3 ("keep ai_runs evidence-grade"): validated_output is the
-- full validated MeetingIntelligenceResult (packages/ai's
-- meetingIntelligenceResultSchema) — the audit-trail root. call_records and
-- customer_truth_facts are derived/materialized FROM this column, they are
-- never the only surviving representation of what the model actually
-- produced.
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  transcript_id uuid not null references public.meeting_transcripts (id) on delete cascade,
  run_type text not null default 'meeting_intelligence',
  model text not null,
  prompt_version text not null,
  provider_config_version text not null,
  status public.ai_run_status not null default 'pending',
  -- Denormalized from validated_output.summary at completion time for
  -- cheap display without parsing jsonb (same reasoning as
  -- meeting_transcripts.detected_language being a real column alongside
  -- segments). validated_output remains the authoritative source.
  summary text,
  validated_output jsonb,
  usage_metadata jsonb not null default '{}'::jsonb,
  -- M9 correction #1: set once customer_truth_deltas have been written into
  -- customer_truth_facts (immediately, if meeting.customer_id was already
  -- known at completion time; later, via the deferred-materialization sweep
  -- once linkage resolves). NULL means "not yet materialized" — the
  -- validated_output.customerTruthDeltas are preserved regardless, so
  -- materialization never requires re-running the AI call.
  customer_truth_materialized_at timestamptz,
  error_code text,
  safe_error_metadata jsonb,
  retry_count int not null default 0,
  next_retry_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_runs_identity_uq unique (
    meeting_id, transcript_id, run_type, model, prompt_version, provider_config_version
  )
);

create index ai_runs_claimable_idx
  on public.ai_runs (status, next_retry_at)
  where status in ('pending', 'retryable');

create index ai_runs_materializable_idx
  on public.ai_runs (organization_id, meeting_id)
  where status = 'completed' and customer_truth_materialized_at is null;

create trigger ai_runs_set_updated_at
  before update on public.ai_runs
  for each row execute function public.set_updated_at();

-- Unified action_item/commitment/decision/question/blocker table (redesign
-- doc §5 consolidation decision — one shape, one table, differs by
-- record_type). customer_id is a denormalized reference for
-- "everything outstanding for this customer" queries; it is NOT the RLS
-- boundary (see the RLS migration — visibility follows meeting_id).
create table public.call_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  ai_run_id uuid not null references public.ai_runs (id) on delete cascade,
  record_type public.call_record_type not null,
  description text not null,
  owner_type public.call_record_owner_type not null,
  owner_membership_id uuid references public.organization_memberships (id) on delete set null,
  external_owner_name text,
  source_speaker text,
  evidence_segment_ids uuid[] not null,
  due_at timestamptz,
  status public.call_record_status not null default 'detected',
  dependency text,
  blocks_lifecycle_step boolean not null default false,
  carried_from_prior_record_id uuid references public.call_records (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- cardinality(), not array_length(): array_length() returns NULL (which
  -- a CHECK treats as passing) for an empty array, not 0 — array_length(x,1)
  -- > 0 would silently accept '{}'. Caught by pgTAP 3d during local
  -- verification.
  constraint call_records_evidence_not_empty check (cardinality(evidence_segment_ids) > 0)
);

create index call_records_meeting_idx on public.call_records (meeting_id);
create index call_records_customer_idx on public.call_records (customer_id) where customer_id is not null;
create index call_records_ai_run_idx on public.call_records (ai_run_id);

create trigger call_records_set_updated_at
  before update on public.call_records
  for each row execute function public.set_updated_at();

-- Org-consistency triggers, same shape as every other table in this schema.
create or replace function public.validate_ai_run_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
  v_transcript_org uuid;
  v_transcript_meeting_id uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'ai_runs.meeting_id must belong to the same organization.';
  end if;

  select organization_id, meeting_id into v_transcript_org, v_transcript_meeting_id
    from public.meeting_transcripts where id = new.transcript_id;
  if v_transcript_org is null or v_transcript_org <> new.organization_id then
    raise exception 'ai_runs.transcript_id must belong to the same organization.';
  end if;
  -- Codex plan review (SHOULD-FIX, fixed): same-org alone doesn't stop a
  -- transcript belonging to a DIFFERENT meeting from being attached — this
  -- checks the actual meeting_id match, not just org membership.
  if v_transcript_meeting_id <> new.meeting_id then
    raise exception 'ai_runs.transcript_id must belong to ai_runs.meeting_id.';
  end if;
  return new;
end;
$$;

create trigger ai_runs_validate_org
  before insert or update on public.ai_runs
  for each row execute function public.validate_ai_run_org_consistency();

create or replace function public.validate_call_record_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
  v_customer_org uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'call_records.meeting_id must belong to the same organization.';
  end if;

  if new.customer_id is not null then
    select organization_id into v_customer_org from public.customers where id = new.customer_id;
    if v_customer_org is null or v_customer_org <> new.organization_id then
      raise exception 'call_records.customer_id must belong to the same organization.';
    end if;
  end if;
  return new;
end;
$$;

create trigger call_records_validate_org
  before insert or update on public.call_records
  for each row execute function public.validate_call_record_org_consistency();

-- Evidence-array integrity: Postgres can't FK-constrain a uuid[], so this
-- trigger is the actual enforcement that evidence_segment_ids only ever
-- points at real segments belonging to THIS meeting's transcript. Applies
-- to call_records (meeting_id known directly) and, in the next migration,
-- to customer_truth_facts (checked against source_meeting_id).
create or replace function public.validate_call_record_evidence_segments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_valid_count int;
begin
  select count(*) into v_valid_count
  from public.transcript_segments ts
  join public.meeting_transcripts mt on mt.id = ts.transcript_id
  where ts.id = any(new.evidence_segment_ids)
    and mt.meeting_id = new.meeting_id;

  if v_valid_count <> coalesce(array_length(new.evidence_segment_ids, 1), 0) then
    raise exception 'call_records.evidence_segment_ids must all belong to a transcript segment of the same meeting.';
  end if;
  return new;
end;
$$;

create trigger call_records_validate_evidence
  before insert or update on public.call_records
  for each row execute function public.validate_call_record_evidence_segments();

-- Durable, idempotent worker queue — same FOR UPDATE SKIP LOCKED shape as
-- claim_next_transcription_job (M8) / claim_next_calendar_event_job (M4).
create or replace function public.claim_next_meeting_intelligence_run()
returns public.ai_runs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ai_runs;
begin
  select * into v_row
  from public.ai_runs
  where status in ('pending', 'retryable')
    and (next_retry_at is null or next_retry_at <= now())
  order by created_at
  limit 1
  for update skip locked;

  if v_row.id is null then
    return null;
  end if;

  update public.ai_runs
  set status = 'running', started_at = coalesce(started_at, now())
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default — this
-- must be explicitly revoked, same "revoke-all-then-grant-back" discipline
-- already applied to every TABLE grant in this schema. Caught by pgTAP 2b
-- during local verification (authenticated could call the RPC before this
-- revoke was added).
--
-- CI incident (real, caught by the same pgTAP test against a newer patch
-- of the Supabase postgres image, 17.6.1.167 vs the 17.6.1.166 this was
-- first verified against): `revoke ... from public` alone was NOT
-- sufficient there — the newer image's own baseline setup apparently
-- grants `authenticated` a DIRECT execute entry on new functions, which
-- revoking PUBLIC's entry does not remove. Explicitly revoking from
-- anon/authenticated/service_role by name (matching this schema's own
-- table-grant convention exactly) is robust regardless of what any given
-- Postgres image version defaults to.
revoke execute on function public.claim_next_meeting_intelligence_run() from public, anon, authenticated, service_role;
grant execute on function public.claim_next_meeting_intelligence_run() to service_role;

-- Atomically completes a run: marks ai_runs completed with its full
-- validated output (evidence-grade audit trail, correction #3), and
-- inserts the extracted call_records in the SAME transaction. Deliberately
-- does NOT touch customer_truth_facts — that is always done via
-- materialize_customer_truth_deltas (below), whether immediately after
-- this call or later once customer linkage resolves (correction #1).
-- SECURITY DEFINER: needs no direct INSERT grant on call_records for
-- service_role, same reasoning as complete_transcription_job (M8).
create or replace function public.complete_meeting_intelligence_run(
  p_run_id uuid,
  p_organization_id uuid,
  p_summary text,
  p_validated_output jsonb,
  p_usage_metadata jsonb,
  -- Array of {record_type, description, owner_type, owner_ref,
  -- external_owner_name, source_speaker, evidence_segment_ids, due_at} —
  -- built by the domain layer from the provider's own validated output,
  -- not raw provider output.
  p_call_records jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.ai_run_status;
  v_meeting_id uuid;
begin
  select status, meeting_id into v_status, v_meeting_id
    from public.ai_runs
    where id = p_run_id and organization_id = p_organization_id
    for update;

  if v_status is null then
    return false; -- not found in this org
  end if;
  if v_status = 'completed' then
    -- Already completed (e.g. a concurrent duplicate claim somehow ran
    -- twice) — never re-touch existing evidence.
    return false;
  end if;

  update public.ai_runs
  set status = 'completed',
      summary = p_summary,
      validated_output = p_validated_output,
      usage_metadata = p_usage_metadata,
      completed_at = now()
  where id = p_run_id and organization_id = p_organization_id;

  insert into public.call_records (
    organization_id, meeting_id, ai_run_id, record_type, description,
    owner_type, owner_membership_id, external_owner_name, source_speaker,
    evidence_segment_ids, due_at
  )
  select
    p_organization_id,
    v_meeting_id,
    p_run_id,
    (rec ->> 'record_type')::public.call_record_type,
    rec ->> 'description',
    (rec ->> 'owner_type')::public.call_record_owner_type,
    nullif(rec ->> 'owner_membership_id', '')::uuid,
    nullif(rec ->> 'external_owner_name', ''),
    nullif(rec ->> 'source_speaker', ''),
    array(select jsonb_array_elements_text(rec -> 'evidence_segment_ids'))::uuid[],
    nullif(rec ->> 'due_at', '')::timestamptz
  from jsonb_array_elements(coalesce(p_call_records, '[]'::jsonb)) as rec;

  return true;
end;
$$;

revoke execute on function public.complete_meeting_intelligence_run(
  uuid, uuid, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_meeting_intelligence_run(
  uuid, uuid, text, jsonb, jsonb, jsonb
) to service_role;
