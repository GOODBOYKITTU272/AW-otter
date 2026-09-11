-- Plan A: ApplyWizz Signal Internal Evidence + AM Review Gate
--
-- Tables:
-- 1. meeting_recaps (AM review gate, draft -> ready_for_review -> approved)
-- 2. meeting_recap_revisions (append-only audit history of recap changes)
-- 3. meeting_integrity_reports (system-generated transcript integrity verdict)
-- 4. meeting_integrity_flags (system-generated timestamped flags with segment linkage)
--
-- Security rules:
-- - Integrity reports & flags are SYSTEM-GENERATED: authenticated users have SELECT only,
--   never INSERT/UPDATE/DELETE. Writes are service_role only via atomic RPC.
-- - Recaps & revisions can only be mutated by the RESPONSIBLE Account Manager
--   (meeting.owner_membership_id = private.current_membership_id()).
-- - Managers, Senior Managers, and Admins have read-only visibility into recaps and integrity data
--   for meetings within their authorized reporting/org scope.

-- ============================================================================
-- Enums
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'meeting_recap_status') then
    create type public.meeting_recap_status as enum ('draft', 'ready_for_review', 'approved');
  end if;
end;
$$;

-- ============================================================================
-- 1. meeting_recaps
-- ============================================================================

create table if not exists public.meeting_recaps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,

  status public.meeting_recap_status not null default 'draft',

  greeting text not null default '',
  what_we_agreed jsonb not null default '[]'::jsonb,
  applywizz_will_do jsonb not null default '[]'::jsonb,
  candidate_should_do jsonb not null default '[]'::jsonb,
  next_step text not null default '',

  current_revision_id uuid,

  approved_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  approved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_recaps_org_meeting_uq unique (organization_id, meeting_id),
  constraint meeting_recaps_approved_fields check (
    status <> 'approved' or (approved_by_membership_id is not null and approved_at is not null)
  )
);

create index if not exists meeting_recaps_meeting_idx on public.meeting_recaps (meeting_id);
create index if not exists meeting_recaps_org_status_idx on public.meeting_recaps (organization_id, status);

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
  v_customer_org uuid;
  v_approver_org uuid;
begin
  select organization_id into v_meeting_org from public.meetings where id = new.meeting_id;
  if v_meeting_org is null or v_meeting_org <> new.organization_id then
    raise exception 'meeting_recaps.meeting_id must belong to the same organization.';
  end if;

  if new.customer_id is not null then
    select organization_id into v_customer_org from public.customers where id = new.customer_id;
    if v_customer_org is null or v_customer_org <> new.organization_id then
      raise exception 'meeting_recaps.customer_id must belong to the same organization.';
    end if;
  end if;

  if new.approved_by_membership_id is not null then
    select organization_id into v_approver_org from public.organization_memberships where id = new.approved_by_membership_id;
    if v_approver_org is null or v_approver_org <> new.organization_id then
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

-- SELECT: visible when the underlying meeting is visible (AM owner, reporting manager, senior manager, admin)
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

-- INSERT: only the responsible AM who owns the meeting can insert a recap
create policy meeting_recaps_insert_responsible_am
  on public.meeting_recaps
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
        and m.organization_id = private.current_organization_id()
        and m.owner_membership_id = private.current_membership_id()
    )
  );

-- UPDATE: only the responsible AM who owns the meeting can update a recap
create policy meeting_recaps_update_responsible_am
  on public.meeting_recaps
  for update
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
        and m.organization_id = private.current_organization_id()
        and m.owner_membership_id = private.current_membership_id()
    )
  )
  with check (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recaps.meeting_id
        and m.organization_id = private.current_organization_id()
        and m.owner_membership_id = private.current_membership_id()
    )
  );

-- ============================================================================
-- 2. meeting_recap_revisions (append-only)
-- ============================================================================

create table if not exists public.meeting_recap_revisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  recap_id uuid not null references public.meeting_recaps (id) on delete cascade,

  revision_number integer not null check (revision_number >= 1),
  created_by_membership_id uuid references public.organization_memberships (id) on delete set null,

  greeting text not null default '',
  what_we_agreed jsonb not null default '[]'::jsonb,
  applywizz_will_do jsonb not null default '[]'::jsonb,
  candidate_should_do jsonb not null default '[]'::jsonb,
  next_step text not null default '',

  revision_reason text,
  created_at timestamptz not null default now(),

  constraint meeting_recap_revisions_recap_num_uq unique (recap_id, revision_number)
);

create index if not exists meeting_recap_revisions_recap_idx on public.meeting_recap_revisions (recap_id, revision_number desc);

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

create trigger meeting_recap_revisions_no_update
  before update on public.meeting_recap_revisions
  for each row execute function public.prevent_meeting_recap_revisions_mutation();

create trigger meeting_recap_revisions_no_delete
  before delete on public.meeting_recap_revisions
  for each row execute function public.prevent_meeting_recap_revisions_mutation();

-- Org consistency trigger for meeting_recap_revisions
create or replace function public.validate_meeting_recap_revision_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recap_org uuid;
  v_creator_org uuid;
begin
  select organization_id into v_recap_org from public.meeting_recaps where id = new.recap_id;
  if v_recap_org is null or v_recap_org <> new.organization_id then
    raise exception 'meeting_recap_revisions.recap_id must belong to the same organization.';
  end if;

  if new.created_by_membership_id is not null then
    select organization_id into v_creator_org from public.organization_memberships where id = new.created_by_membership_id;
    if v_creator_org is null or v_creator_org <> new.organization_id then
      raise exception 'meeting_recap_revisions.created_by_membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meeting_recap_revisions_validate_org
  before insert or update on public.meeting_recap_revisions
  for each row execute function public.validate_meeting_recap_revision_org_consistency();

alter table public.meeting_recap_revisions enable row level security;
revoke all on public.meeting_recap_revisions from anon, authenticated, service_role;
grant select, insert on public.meeting_recap_revisions to authenticated;
grant select, insert, delete on public.meeting_recap_revisions to service_role;

-- SELECT: visible when the underlying meeting is visible
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

-- INSERT: only the responsible AM who owns the meeting can insert a revision
create policy meeting_recap_revisions_insert_responsible_am
  on public.meeting_recap_revisions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.meeting_recaps r
      join public.meetings m on m.id = r.meeting_id
      where r.id = meeting_recap_revisions.recap_id
        and m.organization_id = private.current_organization_id()
        and m.owner_membership_id = private.current_membership_id()
    )
  );

-- ============================================================================
-- 3. meeting_integrity_reports (system-generated, read-only for authenticated)
-- ============================================================================

create table if not exists public.meeting_integrity_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,

  overall_verdict text not null check (
    overall_verdict in (
      'good',
      'needs_review',
      'suspected_background_media',
      'poor_audio',
      'insufficient_speech',
      'transcription_unreliable'
    )
  ),
  summary text not null,
  confidence_score_avg numeric check (
    confidence_score_avg is null or (confidence_score_avg >= 0 and confidence_score_avg <= 1)
  ),
  suspected_background_media boolean not null default false,
  metrics jsonb not null default '{}'::jsonb,

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_integrity_reports_org_meeting_uq unique (organization_id, meeting_id)
);

create index if not exists meeting_integrity_reports_meeting_idx on public.meeting_integrity_reports (meeting_id);

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
grant select on public.meeting_integrity_reports to authenticated;
grant select, insert, update, delete on public.meeting_integrity_reports to service_role;

-- SELECT ONLY for authenticated (Blocker 1: AM/Manager cannot insert/update integrity reports)
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

-- ============================================================================
-- 4. meeting_integrity_flags (system-generated, read-only for authenticated)
-- ============================================================================

create table if not exists public.meeting_integrity_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  report_id uuid not null references public.meeting_integrity_reports (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  transcript_segment_id uuid references public.transcript_segments (id) on delete set null,

  flag_type text not null check (
    flag_type in (
      'possible_background_media_or_stt_artifact',
      'transcript_speech_gap',
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

create index if not exists meeting_integrity_flags_report_idx on public.meeting_integrity_flags (report_id, start_ms);
create index if not exists meeting_integrity_flags_meeting_idx on public.meeting_integrity_flags (meeting_id);
create index if not exists meeting_integrity_flags_segment_idx on public.meeting_integrity_flags (transcript_segment_id) where transcript_segment_id is not null;

-- Consistency trigger for meeting_integrity_flags
create or replace function public.validate_meeting_integrity_flag_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_org uuid;
  v_report_meeting uuid;
  v_segment_meeting uuid;
begin
  select organization_id, meeting_id into v_report_org, v_report_meeting
  from public.meeting_integrity_reports where id = new.report_id;

  if v_report_org is null or v_report_org <> new.organization_id then
    raise exception 'meeting_integrity_flags.report_id must belong to the same organization.';
  end if;

  if v_report_meeting is null or v_report_meeting <> new.meeting_id then
    raise exception 'meeting_integrity_flags.meeting_id must match the report meeting_id.';
  end if;

  if new.transcript_segment_id is not null then
    select t.meeting_id into v_segment_meeting
    from public.transcript_segments s
    join public.meeting_transcripts t on t.id = s.transcript_id
    where s.id = new.transcript_segment_id;

    if v_segment_meeting is null or v_segment_meeting <> new.meeting_id then
      raise exception 'meeting_integrity_flags.transcript_segment_id must belong to a transcript of the same meeting.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meeting_integrity_flags_validate
  before insert or update on public.meeting_integrity_flags
  for each row execute function public.validate_meeting_integrity_flag_consistency();

alter table public.meeting_integrity_flags enable row level security;
revoke all on public.meeting_integrity_flags from anon, authenticated, service_role;
grant select on public.meeting_integrity_flags to authenticated;
grant select, insert, update, delete on public.meeting_integrity_flags to service_role;

-- SELECT ONLY for authenticated (Blocker 1: AM/Manager cannot insert/update integrity flags)
create policy meeting_integrity_flags_select_visible
  on public.meeting_integrity_flags
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_integrity_flags.meeting_id
    )
  );

-- ============================================================================
-- 5. Atomic Integrity Report + Flags Replacement RPC (Blocker 7)
-- ============================================================================

create or replace function public.save_meeting_integrity_report_atomic(
  p_organization_id uuid,
  p_meeting_id uuid,
  p_overall_verdict text,
  p_summary text,
  p_confidence_score_avg numeric,
  p_suspected_background_media boolean,
  p_metrics jsonb,
  p_flags jsonb
)
returns public.meeting_integrity_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.meeting_integrity_reports;
begin
  -- 1. Atomic upsert of the head report row
  insert into public.meeting_integrity_reports (
    organization_id,
    meeting_id,
    overall_verdict,
    summary,
    confidence_score_avg,
    suspected_background_media,
    metrics,
    evaluated_at,
    updated_at
  )
  values (
    p_organization_id,
    p_meeting_id,
    p_overall_verdict,
    p_summary,
    p_confidence_score_avg,
    coalesce(p_suspected_background_media, false),
    coalesce(p_metrics, '{}'::jsonb),
    now(),
    now()
  )
  on conflict (organization_id, meeting_id)
  do update set
    overall_verdict = excluded.overall_verdict,
    summary = excluded.summary,
    confidence_score_avg = excluded.confidence_score_avg,
    suspected_background_media = excluded.suspected_background_media,
    metrics = excluded.metrics,
    evaluated_at = excluded.evaluated_at,
    updated_at = excluded.updated_at
  returning * into v_report;

  -- 2. Clear previous flags atomically within the same transaction
  delete from public.meeting_integrity_flags
  where report_id = v_report.id;

  -- 3. Insert new flags atomically
  if p_flags is not null and jsonb_array_length(p_flags) > 0 then
    insert into public.meeting_integrity_flags (
      organization_id,
      report_id,
      meeting_id,
      transcript_segment_id,
      flag_type,
      severity,
      start_ms,
      end_ms,
      reason_code,
      message,
      detector_version
    )
    select
      p_organization_id,
      v_report.id,
      p_meeting_id,
      nullif(f ->> 'transcript_segment_id', '')::uuid,
      f ->> 'flag_type',
      f ->> 'severity',
      (f ->> 'start_ms')::integer,
      (f ->> 'end_ms')::integer,
      f ->> 'reason_code',
      f ->> 'message',
      coalesce(f ->> 'detector_version', 'v1')
    from jsonb_array_elements(p_flags) as f;
  end if;

  return v_report;
end;
$$;

-- Security Definer Discipline:
-- Revoke execute from public, anon, and authenticated.
-- Grant execute ONLY to service_role (worker/internal pipeline only).
revoke all on function public.save_meeting_integrity_report_atomic(uuid, uuid, text, text, numeric, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_meeting_integrity_report_atomic(uuid, uuid, text, text, numeric, boolean, jsonb, jsonb) to service_role;
