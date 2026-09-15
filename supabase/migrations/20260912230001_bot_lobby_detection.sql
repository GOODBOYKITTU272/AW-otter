-- Phase-1 P0: Teams lobby detection and alerting for CRM customer calls
-- Adds explicit lobby-waiting tracking to meeting_bot_jobs so ops/admin/AMs
-- can see when Echo is stuck waiting for admission (not silent failure).

-- Add lobby_waiting_since timestamp: set when Vexa reports 'awaiting_admission',
-- 'waiting_for_admission', or 'needs_help'; cleared when bot joins or fails.
-- This enables "how long has the bot been stuck in lobby?" queries and urgent alerts.
alter table public.meeting_bot_jobs
  add column lobby_waiting_since timestamptz;

-- Add last_raw_status text: preserves Vexa's exact status string for diagnostics
-- (provider_metadata already has full raw response, but extracting status from
-- JSONB in every query is expensive; this denormalized field is query-friendly).
alter table public.meeting_bot_jobs
  add column last_raw_status text;

comment on column public.meeting_bot_jobs.lobby_waiting_since is
  'Timestamp when bot entered lobby/waiting-for-admission state. Null when not waiting. Used for "action required" alerts.';

comment on column public.meeting_bot_jobs.last_raw_status is
  'Vexa''s exact status string from most recent poll (awaiting_admission, in_call_recording, etc). For diagnostics and granular lobby detection.';
