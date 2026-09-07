-- Canonical meeting dedupe redesign + tenant-level (app-only) Microsoft
-- connection. Reviewed by Codex (design gate before implementation):
-- iCalUId is unique per-occurrence even within a recurring series (verified
-- against Graph docs — RFC 5545's "shared UID, distinguished by
-- RECURRENCE-ID" behavior is NOT how Graph's REST iCalUId works), so the
-- canonical key does NOT need scheduled_start alongside it — including it
-- would have created duplicate risk on first observation after a
-- reschedule. No production data exists yet (no real Microsoft OAuth
-- connection has ever completed end-to-end in this project), so this is a
-- clean breaking change to `meetings`, not a backfill.

-- mailbox event id (external_event_id) is now provider/mailbox sync
-- identity only — a canonical meeting can be observed via multiple
-- mailboxes once tenant-wide sync covers every employee by default, so it
-- can no longer live as a single scalar column on meetings.
drop index if exists public.meetings_org_provider_event_uq;

alter table public.meetings
  drop column external_event_id,
  add column ical_uid text not null,
  -- Debugging/metadata only, not part of identity (per Codex's review —
  -- don't branch identity logic on these unless real verification proves
  -- iCalUId unstable, which it isn't).
  add column graph_event_type text,
  add column series_master_id text,
  add column original_start timestamptz;

create unique index meetings_org_provider_ical_uid_uq
  on public.meetings (organization_id, provider, ical_uid);

-- The real lookup surface: which mailbox's copy (external_event_id) maps
-- to which canonical meeting. Required (not optional) for correct
-- cancellation handling — a Graph "deleted" notification carries only an
-- id, no event body, so there's no iCalUId to resolve identity from at
-- cancel time; this mapping is the only way to know what to cancel.
-- is_organizer (from Graph's own `isOrganizer` field, per Codex's review —
-- more reliable than comparing email strings) drives whether a delete from
-- THIS mailbox cancels the canonical meeting for everyone, or just removes
-- this one observer's mapping (e.g. a non-organizer attendee declining).
-- organization_id is denormalized onto this row deliberately (Codex's
-- final review, Finding #2): every other table in this schema
-- (meetings, calendar_event_jobs) carries organization_id directly, and
-- this table's own lookups run through the service-role client, which
-- bypasses RLS entirely — without organization_id here, those lookups had
-- zero org boundary of their own, relying only on provider_user_key
-- happening to be unique tenant-wide. Redundant with meetings.organization_id
-- via the FK, but that's the point: a lookup that filters by the wrong
-- org's organization_id simply won't match, even if provider_user_key +
-- external_event_id happened to collide across orgs.
create table public.meeting_external_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'microsoft',
  provider_user_key text not null,
  external_event_id text not null,
  is_organizer boolean not null default false,
  last_seen_at timestamptz not null default now()
);

create unique index meeting_external_events_lookup_uq
  on public.meeting_external_events (organization_id, provider, provider_user_key, external_event_id);

create index meeting_external_events_meeting_idx
  on public.meeting_external_events (meeting_id);

-- Every job now carries which mailbox it was discovered through — needed
-- by the same mapping-table resolution above. Populated at enqueue time
-- (work_email of the owning employee), even for delegated-only jobs, so
-- processing has one consistent field regardless of auth mode.
alter table public.calendar_event_jobs
  add column provider_user_key text not null;

-- Tenant-level (app-only/client-credentials) Microsoft connection: one row
-- per organization, admin-managed, no per-connection secrets to store —
-- unlike delegated OAuth, app-only auth has nothing per-connection to
-- persist. The tenant credential IS the existing MICROSOFT_TENANT_ID/
-- CLIENT_ID/CLIENT_SECRET env vars (server-side only, never stored here).
-- This row is just "has an admin turned this on for this org, and
-- who/when" — same role as calendar_connections' status/audit fields, but
-- with no user-specific consent artifact to track.
--
-- Documented assumption: one production Microsoft/Entra tenant maps to one
-- real ApplyWizz organization (matches the blueprint's "internal
-- ApplyWizz" deployment target). Org A/Org B in test fixtures exist only
-- to prove RLS cross-org isolation, not because multi-org-per-tenant is a
-- real target. If that assumption ever changes, Microsoft's Exchange
-- Application Access Policies are the sharper mailbox-restriction control
-- to add (https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies).
create table public.microsoft_tenant_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'microsoft',
  status text not null default 'active',
  connected_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  connected_at timestamptz not null default now(),
  -- Same shape/purpose as calendar_connections.last_reconciliation_result —
  -- one row, overwritten each run, written by reconcileTenantOrganization.
  last_reconciliation_result jsonb,
  updated_at timestamptz not null default now()
);

create unique index microsoft_tenant_connections_org_provider_uq
  on public.microsoft_tenant_connections (organization_id, provider);

create trigger microsoft_tenant_connections_set_updated_at
  before update on public.microsoft_tenant_connections
  for each row execute function public.set_updated_at();
