-- M4: canonical meetings, reconciled from Microsoft calendar events via the
-- M3 provider layer. customer_id is DEFERRED (no `customers` table exists
-- yet) — same pattern M1 used for department_id/team_id before M2 built
-- those tables: document the omission, don't stub a fake FK.
create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  owner_membership_id uuid references public.organization_memberships (id) on delete set null,
  provider text not null default 'microsoft',
  external_event_id text not null,
  meeting_url text,
  title text not null,
  meeting_type text,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  actual_start timestamptz,
  actual_end timestamptz,
  -- M4 never sets anything but 'pending' — deciding record/exclude/etc is
  -- M5's job (meeting policy evaluation is explicitly out of M4's scope).
  eligibility_status text not null default 'pending',
  lifecycle_status text not null default 'upcoming',
  reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index meetings_org_provider_event_uq
  on public.meetings (organization_id, provider, external_event_id);

create index meetings_owner_start_idx
  on public.meetings (owner_membership_id, scheduled_start);

create trigger meetings_set_updated_at
  before update on public.meetings
  for each row execute function public.set_updated_at();

create table public.meeting_attendees (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  email extensions.citext,
  display_name text,
  participant_type text,
  invited boolean,
  attended boolean,
  joined_at timestamptz,
  left_at timestamptz,
  provider_participant_id text
);

create index meeting_attendees_meeting_email_idx
  on public.meeting_attendees (meeting_id, email);

create index meeting_attendees_meeting_attended_idx
  on public.meeting_attendees (meeting_id, attended);

-- Durable, Postgres-backed queue (TRD's "calendar-events" queue). The
-- webhook handler enqueues a job (fast, no Graph calls in the request);
-- processCalendarEventQueue (packages/domain) dequeues and does the actual
-- Graph fetch + canonical upsert. organization_id/provider are captured at
-- enqueue time from OUR stored calendar_connections row — never trusted
-- from the webhook payload itself — purely for operational
-- debugging/filtering, not an authorization decision.
create table public.calendar_event_jobs (
  id uuid primary key default gen_random_uuid(),
  calendar_connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'microsoft',
  external_event_id text not null,
  change_type text not null,
  status text not null default 'pending',
  attempts int not null default 0,
  last_error text,
  run_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe: multiple notifications for the same event+change before the
-- first is processed collapse into one pending job rather than piling up.
-- Once a job leaves pending/processing (completed/failed/dead_letter), a
-- fresh notification is free to enqueue a new one.
create unique index calendar_event_jobs_pending_dedupe_uq
  on public.calendar_event_jobs (calendar_connection_id, external_event_id, change_type)
  where status in ('pending', 'processing');

create index calendar_event_jobs_status_run_at_idx
  on public.calendar_event_jobs (status, run_at);

create trigger calendar_event_jobs_set_updated_at
  before update on public.calendar_event_jobs
  for each row execute function public.set_updated_at();

-- Atomic dequeue: PostgREST/supabase-js can't express `FOR UPDATE SKIP
-- LOCKED` through .from() query chains, so claiming a job is a SQL
-- function. SECURITY DEFINER because only service_role calls this (see
-- RLS migration — calendar_event_jobs has zero policies/grants for
-- anon/authenticated), and the function itself is the only sanctioned way
-- to transition a job out of 'pending'.
create or replace function public.claim_next_calendar_event_job()
returns public.calendar_event_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.calendar_event_jobs;
begin
  select * into v_job
  from public.calendar_event_jobs
  where status = 'pending'
    and run_at <= now()
  order by run_at
  limit 1
  for update skip locked;

  if v_job.id is null then
    return null;
  end if;

  update public.calendar_event_jobs
  set status = 'processing'
  where id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;

grant execute on function public.claim_next_calendar_event_job() to service_role;
