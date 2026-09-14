-- Meeting Outcomes: Fathom-style structured overview extraction
-- Stores lightweight Overview-tab content: summary, key decisions, action items, open questions
-- Separate from the full meeting_intelligence pipeline (ai_runs) — this is a simpler,
-- faster extraction focused purely on what the Overview tab needs to render.

create table public.meeting_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  transcript_id uuid not null references public.meeting_transcripts (id) on delete cascade,
  
  -- The structured outcome (validated against meetingOutcomeSchema in packages/ai)
  summary text not null,
  key_decisions jsonb not null default '[]'::jsonb,
  action_items jsonb not null default '[]'::jsonb,
  open_questions jsonb not null default '[]'::jsonb,
  
  -- Generation metadata
  model text not null,
  prompt_version text not null default 'v1',
  generated_at timestamptz not null default now(),
  usage_metadata jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  -- One outcome per meeting (latest always wins)
  constraint meeting_outcomes_meeting_uq unique (meeting_id)
);

create index meeting_outcomes_organization_idx on public.meeting_outcomes (organization_id);
create index meeting_outcomes_transcript_idx on public.meeting_outcomes (transcript_id);

create trigger meeting_outcomes_set_updated_at
  before update on public.meeting_outcomes
  for each row execute function public.set_updated_at();

-- Org-consistency trigger
create or replace function public.validate_meeting_outcome_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
  v_transcript_org uuid;
  v_transcript_meeting_id uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'meeting_outcomes.meeting_id must belong to the same organization.';
  end if;

  select organization_id, meeting_id into v_transcript_org, v_transcript_meeting_id
    from public.meeting_transcripts where id = new.transcript_id;
  if v_transcript_org is null or v_transcript_org <> new.organization_id then
    raise exception 'meeting_outcomes.transcript_id must belong to the same organization.';
  end if;
  if v_transcript_meeting_id <> new.meeting_id then
    raise exception 'meeting_outcomes.transcript_id must belong to meeting_outcomes.meeting_id.';
  end if;
  return new;
end;
$$;

create trigger meeting_outcomes_validate_org
  before insert or update on public.meeting_outcomes
  for each row execute function public.validate_meeting_outcome_org_consistency();

-- RLS: meeting_outcomes visibility follows meetings visibility
alter table public.meeting_outcomes enable row level security;

create policy meeting_outcomes_select
  on public.meeting_outcomes for select
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_outcomes.meeting_id
    )
  );

-- Only service_role can write (background worker)
create policy meeting_outcomes_insert
  on public.meeting_outcomes for insert
  with check (false);

create policy meeting_outcomes_update
  on public.meeting_outcomes for update
  using (false);

grant select on public.meeting_outcomes to authenticated;
