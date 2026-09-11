-- P3B Forward Migration: Update complete_transcription_job to persist
-- provider_segment_metadata (word timestamps, numeric speaker IDs, diarization tags).
-- Preserves exact function signature, atomic transaction, SECURITY DEFINER,
-- search_path = public, organization checks, and completed-transcript immutability.

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

revoke execute on function public.complete_transcription_job(uuid, uuid, text, text, boolean, jsonb, jsonb, numeric, numeric, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.complete_transcription_job(uuid, uuid, text, text, boolean, jsonb, jsonb, numeric, numeric, jsonb) to service_role;
