-- M8: evidence-grade meeting transcripts. Real-audio investigation (2026-09-08)
-- confirmed: Vexa records audio independently of transcribe_enabled (already
-- true for every M6 bot session — no change to bot creation needed), but its
-- exported media is a concatenated chunk stream that OpenRouter's Whisper
-- backend rejects outright ("unsupported or malformed audio") — a local
-- ffmpeg remux/transcode step (packages/domain/src/audio-transcode.ts) is a
-- required pipeline stage, verified for real against a real Vexa recording
-- before this migration was written.
--
-- One row per meeting (not per attempt): the unique constraint below IS the
-- idempotency/no-duplicate-transcript enforcement — a retried/duplicate
-- worker claim updates the same row, it never creates a second one.

create type public.transcript_processing_status as enum (
  'pending',
  'processing',
  'completed',
  'failed',
  'retryable'
);

-- 'unavailable' is the only value M8 ever writes (readiness investigation:
-- Vexa's /participants endpoint exists but returned an empty roster against
-- our real test session — no genuine speaker-identity signal is confirmed
-- available yet). 'vexa_participants' and 'manual' are reserved for when
-- that changes, so transcript_segments' shape doesn't need to change later.
create type public.speaker_source as enum (
  'unavailable',
  'vexa_participants',
  'manual'
);

create table public.meeting_transcripts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  provider text not null default 'openrouter',
  model text,
  processing_status public.transcript_processing_status not null default 'pending',
  -- {recordingId, mediaFileId, platform, nativeMeetingId} — a REFERENCE to
  -- the Vexa artifact, never the audio bytes themselves (raw audio must
  -- never enter Postgres).
  source_audio_reference jsonb,
  detected_language text,
  has_canonical_english boolean not null default false,
  -- Provider response metadata (model/task/etc) minus anything that could
  -- be a secret or full transcript text — see the domain layer's own
  -- "never persist raw transcript text here" rule (segments own that).
  provider_metadata jsonb not null default '{}'::jsonb,
  usage_seconds numeric,
  usage_cost numeric,
  -- error_code is a short machine classification
  -- (download_failed/transcode_failed/transcode_timeout/stt_failed/
  -- stt_malformed_response); safe_error_metadata is status codes/durations
  -- only — never raw provider error bodies that could embed request
  -- content.
  error_code text,
  safe_error_metadata jsonb,
  retry_count int not null default 0,
  next_retry_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_transcripts_org_meeting_uq unique (organization_id, meeting_id)
);

create index meeting_transcripts_claimable_idx
  on public.meeting_transcripts (processing_status, next_retry_at)
  where processing_status in ('pending', 'retryable');

create trigger meeting_transcripts_set_updated_at
  before update on public.meeting_transcripts
  for each row execute function public.set_updated_at();

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  transcript_id uuid not null references public.meeting_transcripts (id) on delete cascade,
  sequence_index int not null,
  start_ms int not null,
  end_ms int not null,
  -- Evidence. Never overwritten with a translation — canonical_english_text
  -- is a separate, additive column (locked by the trigger below once set).
  original_text text not null,
  original_language text,
  canonical_english_text text,
  speaker_id text,
  speaker_label text not null default 'speaker_unknown',
  speaker_source public.speaker_source not null default 'unavailable',
  transcription_confidence numeric,
  translation_confidence numeric,
  -- Defaults true whenever original_language is anything but English, or
  -- unknown — the domain layer sets this explicitly per the real Telugu/
  -- code-switch quality findings (readiness investigation: Telugu and
  -- Telugu-English output was measurably unreliable). Never left to
  -- silently default false for non-English content.
  needs_review boolean not null default false,
  provider_segment_metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint transcript_segments_transcript_seq_uq unique (transcript_id, sequence_index)
);

create index transcript_segments_transcript_idx
  on public.transcript_segments (transcript_id, sequence_index);

create trigger transcript_segments_set_updated_at
  before update on public.transcript_segments
  for each row execute function public.set_updated_at();

-- Org-consistency triggers, same shape/reasoning as every other table in
-- this schema (service_role bypasses RLS entirely — this is the only
-- boundary its own writes get).
create or replace function public.validate_meeting_transcript_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
begin
  select organization_id into v_meeting_org
    from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'meeting_transcripts.meeting_id must belong to the same organization.';
  end if;
  return new;
end;
$$;

create trigger meeting_transcripts_validate_org
  before insert or update on public.meeting_transcripts
  for each row execute function public.validate_meeting_transcript_org_consistency();

create or replace function public.validate_transcript_segment_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transcript_org uuid;
begin
  select organization_id into v_transcript_org
    from public.meeting_transcripts where id = new.transcript_id;
  if v_transcript_org is null or v_transcript_org <> new.organization_id then
    raise exception 'transcript_segments.organization_id must match the referenced transcript''s organization_id.';
  end if;
  return new;
end;
$$;

create trigger transcript_segments_validate_org
  before insert or update on public.transcript_segments
  for each row execute function public.validate_transcript_segment_org_consistency();

-- Evidence immutability (product requirement, stated twice: "do not
-- silently rewrite evidence"). Once a segment's parent transcript is
-- 'completed', its identity/evidence fields (original_text,
-- original_language, timing, speaker fields, sequence_index) can never
-- change — this holds even for service_role, which is the only role with
-- any write grant at all, specifically so a bug in OUR OWN worker code
-- can't silently corrupt already-persisted evidence. canonical_english_text/
-- translation_confidence/needs_review stay mutable: the normalization
-- stage (packages/domain, English-normalization step) is expected to fill
-- those in as a deliberate follow-up write after the transcript itself is
-- already 'completed'.
create or replace function public.prevent_transcript_evidence_mutation()
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

  if v_transcript_status = 'completed' and (
    new.original_text is distinct from old.original_text
    or new.original_language is distinct from old.original_language
    or new.start_ms is distinct from old.start_ms
    or new.end_ms is distinct from old.end_ms
    or new.sequence_index is distinct from old.sequence_index
    or new.speaker_id is distinct from old.speaker_id
    or new.speaker_label is distinct from old.speaker_label
    or new.speaker_source is distinct from old.speaker_source
  ) then
    raise exception 'transcript_segments evidence fields are immutable once the parent transcript is completed.';
  end if;

  return new;
end;
$$;

create trigger transcript_segments_prevent_evidence_mutation
  before update on public.transcript_segments
  for each row execute function public.prevent_transcript_evidence_mutation();

-- Durable, idempotent worker queue — same FOR UPDATE SKIP LOCKED shape as
-- claim_next_calendar_event_job (M4). meeting_transcripts IS the job row
-- (no separate jobs table): processing_status doubles as both domain state
-- and worker-queue state, same convention meeting_bot_jobs already
-- established.
create or replace function public.claim_next_transcription_job()
returns public.meeting_transcripts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.meeting_transcripts;
begin
  select * into v_row
  from public.meeting_transcripts
  where processing_status in ('pending', 'retryable')
    and (next_retry_at is null or next_retry_at <= now())
  order by created_at
  limit 1
  for update skip locked;

  if v_row.id is null then
    return null;
  end if;

  update public.meeting_transcripts
  set processing_status = 'processing', started_at = coalesce(started_at, now())
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.claim_next_transcription_job() to service_role;
