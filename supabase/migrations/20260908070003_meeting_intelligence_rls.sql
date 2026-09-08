-- M9 RLS. Same "visibility = can you see the meeting" convention as
-- meeting_bot_jobs/meeting_transcripts — an EXISTS subquery against
-- meetings inherits meetings' own RLS, and stays correct automatically if
-- meetings' own visibility rules ever change.
--
-- call_records visibility is explicitly meeting-scoped, NOT
-- customer-scoped (redesign doc §13, called out by name): customer_id on
-- call_records is a denormalized query convenience only. Using customer
-- ownership instead would leak evidence from a source meeting the viewer
-- was never authorized to see, just because they own the customer.
--
-- No authenticated insert/update/delete policy on either table: all writes
-- are worker/service-role/RPC driven, matching the exact rule already
-- established for meeting_bot_jobs (M6) and meeting_transcripts (M8).

revoke all on public.ai_runs from anon, authenticated, service_role;
alter table public.ai_runs enable row level security;
grant select on public.ai_runs to authenticated;
grant select, insert, update on public.ai_runs to service_role;

create policy ai_runs_select_meeting_visible
  on public.ai_runs
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = ai_runs.meeting_id
    )
  );

revoke all on public.call_records from anon, authenticated, service_role;
alter table public.call_records enable row level security;
grant select on public.call_records to authenticated;
grant select, insert, update on public.call_records to service_role;

create policy call_records_select_meeting_visible
  on public.call_records
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = call_records.meeting_id
    )
  );
