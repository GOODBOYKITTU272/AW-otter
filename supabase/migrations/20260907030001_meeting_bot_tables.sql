-- M6: MeetingBotProvider + Vexa + automatic Teams bot scheduling. Locked
-- backend-schema doc names this table `meeting_bot_jobs` (05 — Backend
-- Schema, table catalog) — used here exactly. `bot_status` is a
-- deliberately collapsed V1 mapping of the blueprint's more granular
-- provider-normalized enum (scheduled, provisioning, joining, lobby,
-- active, ending, completed, cancelled, failed, removed, timeout): this
-- migration's `pending` is our own pre-provider-call state (not in the
-- blueprint's enum, added because a row must exist before we've ever
-- called the provider); `scheduled` covers provisioning; `joining` covers
-- lobby; `joined` covers active; `ending` is transient and skipped
-- (a real "ending" tick just goes straight to completed); `removed` and
-- `timeout` collapse into `failed`, with the specific reason captured in
-- `last_error`/`provider_metadata` rather than as separate enum values.
-- This mirrors M5's `meeting_policy_rules` V1-simplification precedent —
-- a smaller, explicitly-flagged surface instead of the full provider
-- vocabulary leaking into our own schema.
create type public.bot_status as enum (
  'pending',
  'scheduled',
  'joining',
  'joined',
  'completed',
  'cancelled',
  'failed'
);

-- One row per bot *attempt* for a meeting (`generation` increments if a
-- meeting needs a fresh bot after a prior attempt failed/was cancelled —
-- e.g. an exception gets rejected after already being approved once).
-- organization_id denormalized for the same reason as every M5 table:
-- service_role bypasses RLS entirely, so this is its own explicit org
-- boundary, not just a join through meetings.
create table public.meeting_bot_jobs (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'vexa',
  provider_bot_id text,
  status public.bot_status not null default 'pending',
  generation int not null default 1,
  -- Passed to the provider as a client-supplied dedup token, so a retried
  -- HTTP call for the same (meeting_id, generation) is idempotent on the
  -- provider's side too, not just ours (TRD architecture rule: "every side
  -- effect uses an idempotency key").
  idempotency_key text not null,
  scheduled_at timestamptz,
  joined_at timestamptz,
  left_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  last_error text,
  retry_count int not null default 0,
  next_retry_at timestamptz,
  -- Raw provider response/state, for diagnostics only — provider-specific
  -- shapes never leak past this column into core domain types or the UI.
  provider_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index meeting_bot_jobs_meeting_generation_uq
  on public.meeting_bot_jobs (meeting_id, generation);

create unique index meeting_bot_jobs_idempotency_key_uq
  on public.meeting_bot_jobs (idempotency_key);

create unique index meeting_bot_jobs_provider_bot_id_uq
  on public.meeting_bot_jobs (provider_bot_id)
  where provider_bot_id is not null;

-- THE duplicate-bot guarantee: at most one non-terminal generation per
-- meeting at any time. This is what actually makes "retrying the same
-- meeting must never create a second bot" a database fact, not just an
-- application-logic promise — a second concurrent insert attempt for the
-- same meeting while one is still live fails this constraint outright.
create unique index meeting_bot_jobs_one_live_per_meeting_uq
  on public.meeting_bot_jobs (meeting_id)
  where status not in ('completed', 'cancelled', 'failed');

create index meeting_bot_jobs_org_idx
  on public.meeting_bot_jobs (organization_id);

-- What the worker polls: claim the oldest pending row first.
create index meeting_bot_jobs_status_created_idx
  on public.meeting_bot_jobs (status, created_at)
  where status = 'pending';

create trigger meeting_bot_jobs_set_updated_at
  before update on public.meeting_bot_jobs
  for each row execute function public.set_updated_at();

-- Lightweight lifecycle/event log (locked schema step 54: "Create bot
-- jobs/lifecycle events") — distinct from the general audit_events table,
-- which is actor-driven human activity; this is system-driven automation
-- observability ("Meeting lifecycle, failures, retries... are visible",
-- PRD principle). Admin-only read, matching the Admin Meeting Detail
-- screen's "Technical Log" — a Manager/AM doesn't need the raw event
-- stream, only meeting_bot_jobs' current status (already visible via
-- meetings' own RLS below).
create table public.meeting_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  bot_job_id uuid references public.meeting_bot_jobs (id) on delete set null,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  event_type text not null,
  source text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index meeting_lifecycle_events_meeting_occurred_idx
  on public.meeting_lifecycle_events (meeting_id, occurred_at desc);

create index meeting_lifecycle_events_org_idx
  on public.meeting_lifecycle_events (organization_id);

-- Codex's M6 final review: organization_id is denormalized (deliberately,
-- for service-role's own org boundary) but nothing previously stopped a
-- bad service-role write from setting it to a DIFFERENT org than the
-- referenced meeting's real one — meeting_lifecycle_events_select_admin_org
-- trusts organization_id directly, so a mismatched row would leak an
-- event to the wrong org's admin. This is a DB-level fact, not an
-- app-layer promise: every insert/update on either table must have
-- organization_id = the referenced meeting's real organization_id.
create or replace function public.validate_meeting_bot_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'organization_id must match the referenced meeting''s organization_id.';
  end if;
  return new;
end;
$$;

create trigger meeting_bot_jobs_validate_org
  before insert or update on public.meeting_bot_jobs
  for each row execute function public.validate_meeting_bot_org_consistency();

create trigger meeting_lifecycle_events_validate_org
  before insert or update on public.meeting_lifecycle_events
  for each row execute function public.validate_meeting_bot_org_consistency();
