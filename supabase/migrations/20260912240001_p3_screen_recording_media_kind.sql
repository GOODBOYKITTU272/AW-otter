-- P3: Screen Recording E2E — Add media_kind to support both audio and video recordings
-- 
-- BREAKING CHANGE: The previous UNIQUE(organization_id, meeting_id) allowed only
-- ONE recording artifact per meeting (audio-only). This migration:
-- 1. Adds media_kind ('audio' | 'video') NOT NULL
-- 2. Backfills existing rows as 'audio' (the only kind that existed)
-- 3. Changes uniqueness to UNIQUE(organization_id, meeting_id, media_kind)
-- 4. Raises bucket file_size_limit from 50MiB to 5GiB for video support
--
-- Design: docs/product/screen-recording-spike.md

-- Step 1: Add media_kind as nullable first (required for ALTER on populated table)
alter table public.meeting_recordings
  add column media_kind text;

-- Step 2: Backfill all existing rows as 'audio' (the only type that existed in P2)
update public.meeting_recordings
  set media_kind = 'audio'
  where media_kind is null;

-- Step 3: Make media_kind NOT NULL with CHECK constraint
alter table public.meeting_recordings
  alter column media_kind set not null,
  add constraint meeting_recordings_media_kind_check
    check (media_kind in ('audio', 'video'));

-- Step 4: Drop old single-artifact uniqueness constraint
alter table public.meeting_recordings
  drop constraint meeting_recordings_organization_id_meeting_id_key;

-- Step 5: Add new dual-artifact uniqueness constraint
alter table public.meeting_recordings
  add constraint meeting_recordings_organization_id_meeting_id_media_kind_key
    unique (organization_id, meeting_id, media_kind);

-- Step 6: Update storage path determinism comment (no schema change, doc only)
comment on column public.meeting_recordings.storage_path is
  'Deterministic path: organizations/{org_id}/meetings/{meeting_id}/{media_kind}.original.{ext} — constructable from (org, meeting, kind) alone, enabling crash-recovery reconciliation without needing to query first.';

-- Step 7: Raise bucket file_size_limit from 50MiB to 5GiB for video support
-- 5GiB = 5 * 1024 * 1024 * 1024 = 5368709120 bytes
-- Rationale: 
--   - 1080p screen recording: ~100-300 MB/hour at moderate quality
--   - Typical meeting: 30-60 minutes → ~50-300 MB
--   - 5GiB provides 10-50x headroom for long/high-quality sessions
--   - Still bounded (not unlimited) for cost/abuse protection
update storage.buckets
  set file_size_limit = 5368709120
  where id = 'meeting-recordings';
