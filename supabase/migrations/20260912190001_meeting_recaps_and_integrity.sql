-- Plan A: ApplyWizz Signal Internal Evidence + AM Review Gate
-- Adds:
-- 1. meeting_recaps (draft -> ready_for_review -> approved)
-- 2. meeting_recap_revisions (append-only revision history)
-- 3. meeting_integrity_reports (automated evidence integrity verdict)
-- 4. meeting_integrity_flags (timestamp-level integrity warning annotations)

-- ============================================================================
-- 1. meeting_recaps
-- ============================================================================

create table public.meeting_recaps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,

  status text not null default 'draft' check (status in ('draft', 'ready_for_review', 'approved')),

  approved_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_recaps_org_meeting_uq unique (organization_id, meeting_id),
  constraint meeting_recaps_approval_check check (
    (status <> 'approved') or (approved_by_membership_id is not null and approved_at is not null)
  )
);

create index meeting_recaps_meeting_id_idx on public.meeting_recaps (meeting_id);
create index meeting_recaps_status_idx on public.meeting_recaps (organization_id, status);

create trigger meeting_recaps_set_updated_at
  before update on public.meeting_recaps
  for each row execute function public.set_updated_at();

-- Org consistency trigger for meeting_recaps
create or replace function public.validate_meeting_recap_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_org uuid;
  v_member_org uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'meeting_recaps.meeting_id must belong to the same organization.';
  end if;

  if new.approved_by_membership_id is not null then
    select organization_id into v_member_org from public.organization_memberships where id = new.approved_by_membership_id;
    if v_member_org is null or v_member_org <> new.organization_id then
      raise exception 'meeting_recaps.approved_by_membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meeting_recaps_validate_org
  before insert or update on public.meeting_recaps
  for each row execute function public.validate_meeting_recap_org_consistency();

alter table public.meeting_recaps enable row level security;
revoke all on public.meeting_recaps from anon, authenticated, service_role;
grant select, insert, update on public.meeting_recaps to authenticated;
grant select, insert, update, delete on public.meeting_recaps to service_role;

create policy meeting_recaps_select_meeting_visible
  on public.meeting_recaps
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
    )
  );

create policy meeting_recaps_insert_meeting_visible
  on public.meeting_recaps
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
    )
  );

create policy meeting_recaps_update_meeting_visible
  on public.meeting_recaps
  for update
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
    )
  )
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
    )
  );

-- ============================================================================
-- 2. meeting_recap_revisions (append-only)
-- ============================================================================

create table public.meeting_recap_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  recap_id uuid not null references public.meeting_recaps (id) on delete cascade,

  revision_number integer not null check (revision_number >= 1),
  created_by_membership_id uuid references public.organization_memberships (id) on delete set null,

  greeting text not null,
  agreements jsonb not null default '[]'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  next_step text not null,

  revision_reason text,
  created_at timestamptz not null default now(),

  constraint meeting_recap_revisions_recap_num_uq unique (recap_id, revision_number)
);

create index meeting_recap_revisions_recap_idx on public.meeting_recap_revisions (recap_id, revision_number desc);

-- Append-only enforcement: block update or delete on revisions
create or replace function public.prevent_meeting_recap_revisions_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'meeting_recap_revisions is append-only and cannot be updated or deleted.';
end;
$$;

create trigger meeting_recap_revisions_prevent_mutation
  before update or delete on public.meeting_recap_revisions
  for each row execute function public.prevent_meeting_recap_revisions_mutation();

-- Org consistency trigger for revisions
create or replace function public.validate_meeting_recap_revision_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recap_org uuid;
  v_member_org uuid;
begin
  select organization_id into v_recap_org from public.meeting_recaps where id = new.recap_id;
  if v_recap_org is null or v_recap_org <> new.organization_id then
    raise exception 'meeting_recap_revisions.recap_id must belong to the same organization.';
  end if;

  if new.created_by_membership_id is not null then
    select organization_id into v_member_org from public.organization_memberships where id = new.created_by_membership_id;
    if v_member_org is null or v_member_org <> new.organization_id then
      raise exception 'meeting_recap_revisions.created_by_membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meeting_recap_revisions_validate_org
  before insert on public.meeting_recap_revisions
  for each row execute function public.validate_meeting_recap_revision_org_consistency();

alter table public.meeting_recap_revisions enable row level security;
revoke all on public.meeting_recap_revisions from anon, authenticated, service_role;
grant select, insert on public.meeting_recap_revisions to authenticated;
grant select, insert, delete on public.meeting_recap_revisions to service_role;

create policy meeting_recap_revisions_select_visible
  on public.meeting_recap_revisions
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meeting_recaps r
      join public.meetings m on m.id = r.meeting_id
      where r.id = meeting_recap_revisions.recap_id
    )
  );

create policy meeting_recap_revisions_insert_visible
  on public.meeting_recap_revisions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meeting_recaps r
      join public.meetings m on m.id = r.meeting_id
      where r.id = meeting_recap_revisions.recap_id
    )
  );

-- ============================================================================
-- 3. meeting_integrity_reports
-- ============================================================================

create table public.meeting_integrity_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,

  overall_verdict text not null check (
    overall_verdict in (
      'good',
      'review_recommended',
      'poor_audio',
      'suspected_background_media',
      'insufficient_speech',
      'transcription_unreliable'
    )
  ),
  summary text not null,
  metrics jsonb not null default '{}'::jsonb,

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_integrity_reports_org_meeting_uq unique (organization_id, meeting_id)
);

create index meeting_integrity_reports_meeting_idx on public.meeting_integrity_reports (meeting_id);

create trigger meeting_integrity_reports_set_updated_at
  before update on public.meeting_integrity_reports
  for each row execute function public.set_updated_at();

-- Org consistency trigger for meeting_integrity_reports
create or replace function public.validate_meeting_integrity_report_org_consistency()
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
    raise exception 'meeting_integrity_reports.meeting_id must belong to the same organization.';
  end if;
  return new;
end;
$$;

create trigger meeting_integrity_reports_validate_org
  before insert or update on public.meeting_integrity_reports
  for each row execute function public.validate_meeting_integrity_report_org_consistency();

alter table public.meeting_integrity_reports enable row level security;
revoke all on public.meeting_integrity_reports from anon, authenticated, service_role;
grant select, insert, update on public.meeting_integrity_reports to authenticated;
grant select, insert, update, delete on public.meeting_integrity_reports to service_role;

create policy meeting_integrity_reports_select_visible
  on public.meeting_integrity_reports
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_integrity_reports.meeting_id
    )
  );

create policy meeting_integrity_reports_insert_visible
  on public.meeting_integrity_reports
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_integrity_reports.meeting_id
    )
  );

create policy meeting_integrity_reports_update_visible
  on public.meeting_integrity_reports
  for update
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_integrity_reports.meeting_id
    )
  )
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_integrity_reports.meeting_id
    )
  );

-- ============================================================================
-- 4. meeting_integrity_flags
-- ============================================================================

create table public.meeting_integrity_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  report_id uuid not null references public.meeting_integrity_reports (id) on delete cascade,

  flag_type text not null check (
    flag_type in (
      'audio_gap',
      'background_media',
      'low_confidence',
      'rapid_hallucination',
      'filler_loop',
      'foreign_hallucination'
    )
  ),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms >= start_ms),
  reason_code text not null,
  message text not null,
  detector_version text not null default 'v1',

  created_at timestamptz not null default now()
);

create index meeting_integrity_flags_report_idx on public.meeting_integrity_flags (report_id, start_ms);

-- Org consistency trigger for meeting_integrity_flags
create or replace function public.validate_meeting_integrity_flag_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_org uuid;
begin
  select organization_id into v_report_org from public.meeting_integrity_reports where id = new.report_id;
  if v_report_org is null or v_report_org <> new.organization_id then
    raise exception 'meeting_integrity_flags.report_id must belong to the same organization.';
  end if;
  return new;
end;
$$;

create trigger meeting_integrity_flags_validate_org
  before insert or update on public.meeting_integrity_flags
  for each row execute function public.validate_meeting_integrity_flag_org_consistency();

alter table public.meeting_integrity_flags enable row level security;
revoke all on public.meeting_integrity_flags from anon, authenticated, service_role;
grant select, insert on public.meeting_integrity_flags to authenticated;
grant select, insert, update, delete on public.meeting_integrity_flags to service_role;

create policy meeting_integrity_flags_select_visible
  on public.meeting_integrity_flags
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meeting_integrity_reports r
      join public.meetings m on m.id = r.meeting_id
      where r.id = meeting_integrity_flags.report_id
    )
  );

create policy meeting_integrity_flags_insert_visible
  on public.meeting_integrity_flags
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meeting_integrity_reports r
      join public.meetings m on m.id = r.meeting_id
      where r.id = meeting_integrity_flags.report_id
    )
  );
