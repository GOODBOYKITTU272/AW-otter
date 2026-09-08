-- M8 RLS. Same "visibility = can you see the meeting" convention as
-- meeting_bot_jobs (20260907030002) — an EXISTS subquery against meetings
-- inherits meetings' own RLS (AM-own, admin org-wide, manager-in-tree),
-- and stays correct automatically if meetings' own visibility rules ever
-- change. No authenticated insert/update/delete policy on either table:
-- transcription is exclusively worker/service-role driven, matching the
-- exact same rule meeting_bot_jobs already established for bot lifecycle
-- writes.

revoke all on public.meeting_transcripts from anon, authenticated, service_role;
alter table public.meeting_transcripts enable row level security;
grant select on public.meeting_transcripts to authenticated;
grant select, insert, update on public.meeting_transcripts to service_role;

create policy meeting_transcripts_select_meeting_visible
  on public.meeting_transcripts
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_transcripts.meeting_id
    )
  );

revoke all on public.transcript_segments from anon, authenticated, service_role;
alter table public.transcript_segments enable row level security;
grant select on public.transcript_segments to authenticated;
grant select, insert, update on public.transcript_segments to service_role;

create policy transcript_segments_select_meeting_visible
  on public.transcript_segments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meeting_transcripts t
      where t.id = transcript_segments.transcript_id
    )
  );
