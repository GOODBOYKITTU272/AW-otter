-- M16 Slice B: operational incident tracking for the four job queues'
-- stuck/failed states (see packages/domain/src/operational-incidents.ts
-- and operations-recovery.ts). This is genuinely operational
-- infrastructure — never customer-facing, never AM/manager-facing — so
-- it gets its own table rather than overloading meeting_lifecycle_events
-- (which is meeting-scoped only; calendar_event_jobs has no meeting_id
-- at all).

create table public.operational_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  queue text not null,
  entity_id text not null,
  incident_type text not null,
  severity text not null,
  -- Short, coded text only — enforced at the application layer (every
  -- call site passes a fixed, reviewed string, never provider/customer
  -- content); the column itself is plain text because this table has no
  -- reason to know about transcript/CRM shapes at all.
  reason text not null,
  meeting_id uuid references public.meetings (id) on delete set null,
  occurrence_count int not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger operational_incidents_set_updated_at
  before update on public.operational_incidents
  for each row execute function public.set_updated_at();

-- The actual dedup mechanism: at most one OPEN row per (org, queue,
-- entity, type). A resolved incident recurring later gets a genuinely
-- new row (a fresh alert) because this index only constrains the
-- resolved_at-is-null rows — the standard Postgres idiom for "unique
-- among the still-open ones only."
create unique index operational_incidents_open_dedup_uq
  on public.operational_incidents (organization_id, queue, entity_id, incident_type)
  where resolved_at is null;

create index operational_incidents_org_open_idx
  on public.operational_incidents (organization_id, last_seen_at desc)
  where resolved_at is null;

alter table public.operational_incidents enable row level security;

-- Grants follow the same "no default PUBLIC execute/select" discipline
-- established in M15: explicit named-role grants only. INSERT/UPDATE are
-- service_role-only (the write side is worker infrastructure); SELECT is
-- admin-org-scoped for authenticated, mirroring
-- calendar_event_jobs_select_admin_org exactly — this is genuinely
-- admin-visible operational data, the same posture the four job queue
-- tables already have for admins.
revoke all on public.operational_incidents from public, anon, authenticated;
grant select, insert, update on public.operational_incidents to service_role;
grant select on public.operational_incidents to authenticated;

create policy operational_incidents_select_admin_org
  on public.operational_incidents
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- M16 review fix (SHOULD-FIX 3): recordIncident's original shape was a
-- client-side "select existing, then update occurrence_count+1" — two
-- concurrent calls for the same open incident could both read the same
-- occurrence_count and lose an increment. A single INSERT .. ON CONFLICT
-- .. DO UPDATE SET occurrence_count = occurrence_count + 1 is atomic at
-- the Postgres row-lock level regardless of how many callers race it —
-- the increment is computed server-side, per statement, not client-side
-- from a stale read. The ON CONFLICT target must repeat the exact partial
-- predicate of operational_incidents_open_dedup_uq to be usable as an
-- arbiter. security definer + explicit named-role grants, matching the
-- same pattern already used for claim_next_transcription_job etc.
-- (020260908060001_transcription_tables.sql) — the M15 audit's own
-- guardrail (019_security_definer_privilege_invariant.test.sql) scans
-- every non-trigger SECURITY DEFINER function in `public` automatically,
-- so a missing revoke here would fail that test on its own.
create or replace function public.record_operational_incident(
  p_organization_id uuid,
  p_queue text,
  p_entity_id text,
  p_incident_type text,
  p_severity text,
  p_reason text,
  p_meeting_id uuid default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.operational_incidents
    (organization_id, queue, entity_id, incident_type, severity, reason, meeting_id)
  values
    (p_organization_id, p_queue, p_entity_id, p_incident_type, p_severity, p_reason, p_meeting_id)
  on conflict (organization_id, queue, entity_id, incident_type) where resolved_at is null
  do update set
    occurrence_count = operational_incidents.occurrence_count + 1,
    last_seen_at = now();
$$;

revoke execute on function public.record_operational_incident(uuid, text, text, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_operational_incident(uuid, text, text, text, text, text, uuid) to service_role;
