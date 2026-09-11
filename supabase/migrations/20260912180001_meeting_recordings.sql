-- P2: Signal's first owned object-storage subsystem. Full design at
-- docs/superpowers/specs/2026-09-10-recording-ownership-design.md.
-- No status/retry_count/claim_token — a row's existence IS the state;
-- retry ownership stays entirely with meeting_transcripts (see spec §5
-- for why this is a deliberate simplification, not an oversight).

create table public.meeting_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,

  storage_bucket text not null,
  storage_path text not null,

  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  duration_seconds numeric,
  checksum_sha256 text,

  source_provider text not null,
  source_metadata jsonb not null default '{}'::jsonb,

  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, meeting_id)
);

create trigger meeting_recordings_set_updated_at
  before update on public.meeting_recordings
  for each row execute function public.set_updated_at();

alter table public.meeting_recordings enable row level security;

-- Explicit revoke/grant, matching every other worker-owned table in this
-- codebase (meeting_transcripts, scheduler_calls, operational_incidents):
-- anon gets nothing; authenticated gets select only (writes happen only
-- via RLS-bypassing service-role); service_role gets select/insert/update
-- but never delete (no automatic deletion, per the P2 design).
revoke all on public.meeting_recordings from anon, authenticated, service_role;
grant select on public.meeting_recordings to authenticated;
grant select, insert, update on public.meeting_recordings to service_role;

-- Mirrors meeting_transcripts_select_meeting_visible exactly (confirmed
-- against the live schema during planning) — the real authorization
-- decision (org scope, manager scope, role) is made transitively by
-- meetings' own existing RLS policies inside this EXISTS, not
-- duplicated here.
create policy meeting_recordings_select_meeting_visible
  on public.meeting_recordings
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recordings.meeting_id
    )
  );

-- No insert/update/delete policies for `authenticated` — every write to
-- this table happens via the service-role client from the transcription
-- worker, which bypasses RLS entirely, matching every other
-- worker-owned table in this codebase (meeting_bot_jobs, meeting_transcripts).

-- Private bucket — no public flag, no public read. All legitimate reads
-- go through the signed-URL route (Task 9), which authorizes via this
-- table's own RLS before ever touching Storage. No storage.objects RLS
-- policies are added: every Storage operation in this design (upload,
-- info, download, createSignedUrl) is performed by the service-role
-- client, which bypasses Storage RLS the same way it bypasses table RLS
-- — adding object-level policies here would be dead code, not defense
-- in depth, since no non-service-role caller ever touches Storage
-- directly in this design.
insert into storage.buckets (id, name, public, file_size_limit)
values ('meeting-recordings', 'meeting-recordings', false, 52428800); -- 50MiB, matches supabase/config.toml's local default
