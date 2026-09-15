-- Add online_meeting_id to meetings table for Graph cloud recording lookup
--
-- Context: Microsoft Graph Teams cloud recording API requires the
-- onlineMeeting.id (from Graph's /communications/onlineMeetings resource)
-- to list recordings via /onlineMeetings/{id}/recordings.
--
-- This ID is DIFFERENT from:
-- - external_event_id (Graph calendar event ID, per-mailbox)
-- - ical_uid (RFC 5545 canonical identifier, shared across mailboxes)
--
-- Spike: docs/product/graph-cloud-recording-spike.md

-- Add online_meeting_id column (nullable, since not all meetings have recordings)
ALTER TABLE public.meetings
  ADD COLUMN online_meeting_id TEXT;

-- Index for Graph API lookups (sparse index for non-null values only)
CREATE INDEX meetings_online_meeting_id_idx
  ON public.meetings (online_meeting_id)
  WHERE online_meeting_id IS NOT NULL;

-- Uniqueness: one Echo meeting per Graph online meeting
-- (Prevents duplicate meetings if calendar sync receives same onlineMeeting.id twice)
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_online_meeting_id_unique
    UNIQUE (online_meeting_id);

-- Format validation: Graph online meeting IDs are base64-encoded, typically 100+ chars
-- Example: "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk_thread.v2_19:meeting_..."
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_online_meeting_id_format_check
    CHECK (
      online_meeting_id IS NULL OR
      (length(online_meeting_id) > 20 AND online_meeting_id !~ '\s')
    );

COMMENT ON COLUMN public.meetings.online_meeting_id IS
  'Graph API onlineMeeting.id for cloud recording lookup. Extracted from calendar event onlineMeeting object during sync. NULL for non-Teams meetings or when not available from Graph.';
