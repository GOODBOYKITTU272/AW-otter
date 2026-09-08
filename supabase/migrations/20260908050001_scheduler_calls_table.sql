-- M7A REVISED SCHEDULER INTEGRATION — read-only ingestion table for the
-- real ApplyWizz scheduler API (GET /api/scheduler/calls). Deliberately a
-- separate table from `customers`/`meetings`, not new columns bolted onto
-- either: it is the ingestion/staging layer, `customers` and `meetings`
-- stay the canonical Signal state. Pipeline:
--   customers -> scheduler_calls -> canonical meetings -> bot/transcript.
--
-- Nothing here is CRM integration (see docs/product readiness report,
-- "APPROVE WITH FIXES") — the scheduler API is a read-only scheduled-call
-- context source, never written back to.

create table public.scheduler_calls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- The scheduler row's own `id` (UUID, verified unique against the real
  -- endpoint — 938/938 unique in a live sample). External identity for
  -- this specific scheduled call, distinct from external_applywizz_id
  -- (the customer/lead) and from meeting_id (the canonical Signal meeting,
  -- resolved separately and possibly later).
  external_call_id text not null,
  customer_id uuid not null references public.customers (id) on delete cascade,
  -- Denormalized off customers.external_applywizz_id at ingest time —
  -- kept here too so this row's own identity is self-describing without a
  -- join, same reasoning as organization_id being denormalized everywhere
  -- else in this schema.
  external_applywizz_id text not null,
  -- Resolved to the current holder of this SPECIFIC call — re-resolved on
  -- every sync from external_am_email (verified via live data: the same
  -- lead_id can and does move between AMs mid-lifecycle). Never assumed
  -- permanent. Not null: a row is only ever created once its AM resolves
  -- to an active managed membership (see scheduler-linkage.ts) — an
  -- unresolvable AM email means the row is skipped entirely, not stored
  -- with a null owner.
  owner_membership_id uuid not null references public.organization_memberships (id) on delete restrict,
  external_am_email text not null,
  -- Raw scheduler value (e.g. "DISCOVERY") — preserved forever, even after
  -- an AM corrects canonical_call_type. Never inferred, never overwritten
  -- by a correction.
  external_type text not null,
  canonical_call_type public.call_type not null,
  call_type_source public.call_type_source not null default 'external_scheduler',
  scheduled_at timestamptz not null,
  ends_at timestamptz,
  -- Raw scheduler status (SCHEDULED/COMPLETED/MISSED_BY_AM/NOT_PICKED/
  -- RESCHEDULED, verified against live data) — kept as text, not a new
  -- enum: this is the external system's vocabulary, and it must be free to
  -- add a new status without a Signal migration. Deliberately NEVER
  -- translated into meetings.lifecycle_status or any bot/transcript
  -- status — scheduler outcome and Signal's own meeting/bot lifecycle are
  -- separate concepts (revised plan's explicit instruction).
  external_status text not null,
  teams_link text,
  teams_event_id text,
  teams_online_meeting_id text,
  -- The canonical Signal meeting this call resolved to, via the 4-tier
  -- matcher (scheduler-linkage.ts). Nullable and, once set, terminal — the
  -- matcher never re-evaluates a row that already has one (same
  -- resolved-is-terminal idiom as meetings.customer_link_status). This is
  -- the FK direction the pipeline diagram implies: scheduler_calls points
  -- forward at meetings, not the reverse.
  meeting_id uuid references public.meetings (id) on delete set null,
  -- The scheduler's own created_at/updated_at — preserved as provenance,
  -- distinct from this row's own created_at/updated_at (when SIGNAL first
  -- saw/last touched it).
  source_created_at timestamptz,
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotency: repeated sync of the same scheduler row must upsert, not
  -- duplicate. This is the enforcement.
  constraint scheduler_calls_org_external_call_id_uq unique (organization_id, external_call_id)
);

create index scheduler_calls_customer_idx on public.scheduler_calls (customer_id, scheduled_at desc);

-- Tier-3 candidate lookup: same owner + scheduled-time window.
create index scheduler_calls_owner_scheduled_idx
  on public.scheduler_calls (organization_id, owner_membership_id, scheduled_at);

-- Rows still waiting for a Graph-side meeting match — the matcher's own
-- work queue.
create index scheduler_calls_unmatched_idx
  on public.scheduler_calls (organization_id, owner_membership_id)
  where meeting_id is null;

create trigger scheduler_calls_set_updated_at
  before update on public.scheduler_calls
  for each row execute function public.set_updated_at();

-- Same defense-in-depth shape as validate_meeting_customer_org_consistency
-- (20260908040003) and validate_customer_child_org_consistency
-- (20260908040001): every FK this table carries must resolve to a row in
-- the SAME organization_id, independent of RLS (service_role bypasses RLS
-- entirely — this is the only boundary its own writes get).
create or replace function public.validate_scheduler_call_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_org uuid;
  v_owner_org uuid;
  v_meeting_org uuid;
begin
  select organization_id into v_customer_org
    from public.customers where id = new.customer_id;
  if v_customer_org is null or v_customer_org <> new.organization_id then
    raise exception 'scheduler_calls.customer_id must belong to the same organization.';
  end if;

  select organization_id into v_owner_org
    from public.organization_memberships where id = new.owner_membership_id;
  if v_owner_org is null or v_owner_org <> new.organization_id then
    raise exception 'scheduler_calls.owner_membership_id must belong to the same organization.';
  end if;

  if new.meeting_id is not null then
    select organization_id into v_meeting_org
      from public.meetings where id = new.meeting_id;
    if v_meeting_org is null or v_meeting_org <> new.organization_id then
      raise exception 'scheduler_calls.meeting_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger scheduler_calls_validate_org
  before insert or update on public.scheduler_calls
  for each row execute function public.validate_scheduler_call_org_consistency();
