-- Same baseline issue as 20260906020006 (M1) and 20260906020014 (M3),
-- found here for M2's own tables while investigating the M3 grant bugs:
-- anon ends up with TRUNCATE/REFERENCES/TRIGGER despite never being
-- granted anything explicitly, because departments/teams/audit_events
-- never got the equivalent tighten-default-grants treatment M1's tables
-- did. authenticated carries the same unwanted baseline on
-- departments/teams too (audit_events' authenticated grants are already
-- exactly right via 20260906020011 + 20260906020013 — left untouched).

revoke all on public.departments from anon;
revoke all on public.teams from anon;
revoke all on public.audit_events from anon;

revoke all on public.departments from authenticated;
revoke all on public.teams from authenticated;

grant select, insert, update on public.departments to authenticated;
grant select, insert, update on public.teams to authenticated;
