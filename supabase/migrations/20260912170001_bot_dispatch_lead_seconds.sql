-- Bot dispatch timing: separates "meeting discovered/eligible" from "send
-- the Vexa bot now". Confirmed live during M17C testing: dispatching the
-- instant a meeting becomes eligible (no matter how far in the future it
-- starts) sends the bot into an empty Teams lobby with nobody able to
-- admit it, and Vexa eventually gives up with zero recording.
--
-- Sibling field on meeting_policy_sets, not a new settings table —
-- mirrors cutoff_minutes_before_start exactly: one row per org, same
-- admin-only RLS (meeting_policy_sets_manage), same
-- /api/meeting-policy/set route. NOT NULL DEFAULT 90 means every org
-- (existing rows and future ones) gets the safe default with no backfill
-- step and no null-coalescing scattered through the domain code.
alter table public.meeting_policy_sets
  add column bot_dispatch_lead_seconds integer not null default 90;

-- Same defensive-non-negative convention as the sibling
-- cutoff_minutes_before_start_check already on this table.
alter table public.meeting_policy_sets
  add constraint meeting_policy_sets_bot_dispatch_lead_seconds_check
  check (bot_dispatch_lead_seconds >= 0);
