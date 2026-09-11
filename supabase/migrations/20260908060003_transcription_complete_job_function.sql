-- Codex post-implementation review (2 BLOCKING findings):
-- 1. service_role was never granted DELETE on transcript_segments, so the
--    worker's real delete-then-reinsert retry path would fail against the
--    actual database (pgTAP's `reset role` runs as table owner/superuser,
--    which bypasses grants entirely — the gap was invisible to that test).
-- 2. delete-segments / insert-segments / mark-transcript-completed were
--    three separate PostgREST round-trips — a process death between them
--    left the transcript stuck 'processing' (unclaimable — the queue RPC
--    only claims pending/retryable) with segments already gone.
--
-- Fixed by doing all three in ONE Postgres transaction, the same
-- SECURITY DEFINER shape already used for claim_next_calendar_event_job
-- (M4) and claim_scheduler_call_meeting (M7A) — the function runs with
-- its OWNER's privileges, not the caller's, so this does NOT need (and
-- deliberately does not get) a direct DELETE grant on transcript_segments
-- for service_role at all; only EXECUTE on this function is granted. A
-- status check before the delete is the actual enforcement that evidence
-- from an already-completed transcript is never touched (SHOULD-FIX: the
-- UPDATE-only immutability trigger didn't cover DELETE — see the new
-- BEFORE DELETE trigger below for a second, independent layer of the same
-- protection).

alter table public.transcript_segments
  add constraint transcript_segments_timing_check
  check (start_ms >= 0 and end_ms >= start_ms);

create or replace function public.prevent_transcript_evidence_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transcript_status public.transcript_processing_status;
begin
  select processing_status into v_transcript_status
    from public.meeting_transcripts where id = old.transcript_id;

  if v_transcript_status = 'completed' then
    raise exception 'transcript_segments cannot be deleted once the parent transcript is completed.';
  end if;

  return old;
end;
$$;

create trigger transcript_segments_prevent_evidence_deletion
  before delete on public.transcript_segments
  for each row execute function public.prevent_transcript_evidence_deletion();

create or replace function public.complete_transcription_job(
  p_transcript_id uuid,
  p_organization_id uuid,
  p_model text,
  p_detected_language text,
  p_has_canonical_english boolean,
  p_source_audio_reference jsonb,
  p_provider_metadata jsonb,
  p_usage_seconds numeric,
  p_usage_cost numeric,
  -- Array of {sequence_index, start_ms, end_ms, original_text,
  -- original_language, canonical_english_text, speaker_label,
  -- speaker_source, transcription_confidence, translation_confidence,
  -- needs_review} — built by the domain layer from the provider's own
  -- (already-validated) TranscriptionResult, not raw provider output.
  p_segments jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.transcript_processing_status;
begin
  select processing_status into v_status
    from public.meeting_transcripts
    where id = p_transcript_id and organization_id = p_organization_id
    for update;

  if v_status is null then
    return false; -- not found in this org
  end if;
  if v_status = 'completed' then
    -- Already completed (e.g. a concurrent duplicate claim somehow ran
    -- twice) — never re-touch existing evidence.
    return false;
  end if;

  delete from public.transcript_segments
  where transcript_id = p_transcript_id and organization_id = p_organization_id;

  insert into public.transcript_segments (
    organization_id, transcript_id, sequence_index, start_ms, end_ms,
    original_text, original_language, canonical_english_text,
    speaker_label, speaker_source, transcription_confidence,
    translation_confidence, needs_review, provider_segment_metadata
  )
  select
    p_organization_id,
    p_transcript_id,
    (seg->>'sequence_index')::int,
    (seg->>'start_ms')::int,
    (seg->>'end_ms')::int,
    seg->>'original_text',
    seg->>'original_language',
    seg->>'canonical_english_text',
    coalesce(seg->>'speaker_label', 'speaker_unknown'),
    coalesce((seg->>'speaker_source')::public.speaker_source, 'unavailable'),
    nullif(seg->>'transcription_confidence', '')::numeric,
    nullif(seg->>'translation_confidence', '')::numeric,
    coalesce((seg->>'needs_review')::boolean, false),
    seg->'provider_segment_metadata'
  from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) as seg;

  update public.meeting_transcripts
  set processing_status = 'completed',
      model = p_model,
      detected_language = p_detected_language,
      has_canonical_english = p_has_canonical_english,
      source_audio_reference = p_source_audio_reference,
      provider_metadata = p_provider_metadata,
      usage_seconds = p_usage_seconds,
      usage_cost = p_usage_cost,
      error_code = null,
      safe_error_metadata = null,
      completed_at = now()
  where id = p_transcript_id and organization_id = p_organization_id;

  return true;
end;
$$;

grant execute on function public.complete_transcription_job(
  uuid, uuid, text, text, boolean, jsonb, jsonb, numeric, numeric, jsonb
) to service_role;
