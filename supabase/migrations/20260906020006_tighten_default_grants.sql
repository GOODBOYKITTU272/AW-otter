-- Supabase's platform baseline auto-grants TRUNCATE/REFERENCES/TRIGGER to
-- both `anon` and `authenticated` on every new table in `public`
-- (independent of RLS, and independent of the explicit SELECT/INSERT/UPDATE
-- grants made in 20260906020005_row_level_security.sql). RLS does not
-- govern TRUNCATE at all, so left alone `anon` could truncate any of these
-- tables outright. Revoke everything from both roles first, then grant back
-- exactly what 20260906020005 already established authenticated needs.
--
-- This is defense in depth, found by CI: a fresh database (unlike a
-- long-lived local one) surfaces this baseline cleanly, which is what
-- caught it.

revoke all on public.organizations from anon, authenticated;
revoke all on public.profiles from anon, authenticated;
revoke all on public.organization_memberships from anon, authenticated;
revoke all on public.roles from anon, authenticated;
revoke all on public.permissions from anon, authenticated;
revoke all on public.role_permissions from anon, authenticated;

grant select on public.organizations to authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.organization_memberships to authenticated;
grant select on public.roles to authenticated;
grant select on public.permissions to authenticated;
grant select on public.role_permissions to authenticated;
