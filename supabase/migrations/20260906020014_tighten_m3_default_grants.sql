-- Same baseline issue fixed for M1/M2 tables in
-- 20260906020006_tighten_default_grants.sql: Supabase auto-grants
-- TRUNCATE/REFERENCES/TRIGGER to anon and authenticated on every new public
-- table, independent of RLS and independent of this migration's own
-- SELECT/INSERT/UPDATE grants. Revoke everything first, then grant back
-- exactly what's intended — nothing at all for calendar_connection_secrets.

revoke all on public.calendar_connections from anon, authenticated;
revoke all on public.calendar_connection_secrets from anon, authenticated;
revoke all on public.provider_subscriptions from anon, authenticated;
revoke all on public.calendar_sync_cursors from anon, authenticated;

grant select, insert, update on public.calendar_connections to authenticated;
grant select, insert, update on public.provider_subscriptions to authenticated;
grant select, insert, update on public.calendar_sync_cursors to authenticated;
