-- P3D: Speaker Identity & Business Role Interpretation
-- Enums, table, org-consistency trigger, and RLS policies for additive speaker interpretation.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'speaker_business_role') then
    create type public.speaker_business_role as enum ('AM', 'CANDIDATE', 'OTHER', 'UNKNOWN');
  end if;
end;
$$;

create table if not exists public.meeting_speaker_interpretations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  transcript_id uuid references public.meeting_transcripts (id) on delete cascade,
  raw_speaker_tag text not null,
  business_role public.speaker_business_role not null default 'UNKNOWN',
  interpreted_name text,
  interpreted_email text,
  membership_id uuid references public.organization_memberships (id) on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  interpretation_source text not null default 'unknown_default',
  interpretation_confidence numeric not null default 0.0,
  reasoning text,
  confirmed_by_human boolean not null default false,
  confirmed_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_speaker_interpretations_org_meeting_speaker_uq unique (organization_id, meeting_id, raw_speaker_tag)
);

create index if not exists meeting_speaker_interpretations_meeting_idx
  on public.meeting_speaker_interpretations (organization_id, meeting_id);

create trigger meeting_speaker_interpretations_set_updated_at
  before update on public.meeting_speaker_interpretations
  for each row execute function public.set_updated_at();

create or replace function public.validate_speaker_interpretation_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
  v_customer_org uuid;
  v_membership_org uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'meeting_speaker_interpretations.meeting_id must belong to the same organization.';
  end if;

  if new.customer_id is not null then
    select organization_id into v_customer_org from public.customers where id = new.customer_id;
    if v_customer_org is null or v_customer_org <> new.organization_id then
      raise exception 'meeting_speaker_interpretations.customer_id must belong to the same organization.';
    end if;
  end if;

  if new.membership_id is not null then
    select organization_id into v_membership_org from public.organization_memberships where id = new.membership_id;
    if v_membership_org is null or v_membership_org <> new.organization_id then
      raise exception 'meeting_speaker_interpretations.membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meeting_speaker_interpretations_validate_org
  before insert or update on public.meeting_speaker_interpretations
  for each row execute function public.validate_speaker_interpretation_org_consistency();

alter table public.meeting_speaker_interpretations enable row level security;
revoke all on public.meeting_speaker_interpretations from anon, authenticated, service_role;
grant select, insert, update on public.meeting_speaker_interpretations to authenticated;
grant select, insert, update, delete on public.meeting_speaker_interpretations to service_role;

-- SELECT: visible when the underlying meeting is visible to the authenticated user
create policy meeting_speaker_interpretations_select
  on public.meeting_speaker_interpretations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_speaker_interpretations.meeting_id
    )
  );

-- UPDATE: responsible AM (meeting owner), reporting manager, or org admin
create policy meeting_speaker_interpretations_update
  on public.meeting_speaker_interpretations
  for update
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_speaker_interpretations.meeting_id
        and m.organization_id = private.current_organization_id()
        and (
          m.owner_membership_id = private.current_membership_id()
          or private.is_org_admin()
          or private.is_manager_of(private.current_membership_id(), m.owner_membership_id)
        )
    )
  );
