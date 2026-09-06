-- Learned the hard way across M1-M3: Supabase auto-grants
-- TRUNCATE/REFERENCES/TRIGGER to anon AND authenticated on every new
-- table, and service_role has NO implicit grants at all. Revoke
-- everything from all three roles up front on every M4 table, then grant
-- back exactly what's intended — this time from the start, not as a
-- follow-up fix.

revoke all on public.meetings from anon, authenticated, service_role;
revoke all on public.meeting_attendees from anon, authenticated, service_role;
revoke all on public.calendar_event_jobs from anon, authenticated, service_role;

-- meetings: read your own (you're the owner) or your org's if you're an
-- admin — matches the calendar_connections visibility pattern. Manager/
-- senior_manager direct-report visibility is DEFERRED (same call M2 made
-- for people visibility) — no clean recursive-reporting-line RLS helper
-- exists yet, and building one is out of M4's scope. Writes are
-- service-role only: meetings are populated by the queue
-- processor/reconciliation, never directly by a user's own client.
alter table public.meetings enable row level security;
grant select on public.meetings to authenticated;
grant select, insert, update on public.meetings to service_role;

create policy meetings_select_own
  on public.meetings
  for select
  to authenticated
  using (owner_membership_id = private.current_membership_id());

create policy meetings_select_admin_org
  on public.meetings
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- meeting_attendees: visible exactly where the parent meeting is. No
-- direct authenticated writes — same service-role-only rationale as
-- meetings itself.
alter table public.meeting_attendees enable row level security;
grant select on public.meeting_attendees to authenticated;
grant select, insert, update, delete on public.meeting_attendees to service_role;

create policy meeting_attendees_select_visible
  on public.meeting_attendees
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.meetings m
      where m.id = meeting_attendees.meeting_id
        and (
          m.owner_membership_id = private.current_membership_id()
          or (
            private.is_org_admin()
            and m.organization_id = private.current_organization_id()
          )
        )
    )
  );

-- calendar_event_jobs: purely internal processing state. No end user ever
-- has a reason to see queue internals — zero policies, zero grants to
-- anon/authenticated (same pattern as calendar_connection_secrets).
-- service_role needs select+insert+update to enqueue and process jobs
-- (never delete — failed jobs land in dead_letter, not removed).
alter table public.calendar_event_jobs enable row level security;
grant select, insert, update on public.calendar_event_jobs to service_role;
