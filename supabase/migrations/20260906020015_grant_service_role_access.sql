-- Discovered while building M3: BYPASSRLS (service_role's attribute) only
-- bypasses row-level security policies — it does NOT grant table-level
-- privileges, which is a separate Postgres permission system entirely.
-- service_role had never been explicitly granted SELECT/INSERT/UPDATE on
-- any table in this project (confirmed: it only ever held the same
-- TRUNCATE/REFERENCES/TRIGGER baseline anon/authenticated get). Prior
-- migration comments describing service_role as having "implicit full
-- access" were wrong. This grants exactly what service-role code actually
-- needs, explicitly:
--
-- - calendar_connection_secrets: the M3 encrypted-token table this was
--   discovered on — nothing else can ever reach it (see
--   20260906020013_microsoft_integration_rls.sql), so service_role must be
--   able to.
-- - organizations / roles / organization_memberships: scripts/bootstrap-
--   admin.mjs (M1) creates the first organization and admin using the
--   service-role key and would fail without these — this had never
--   actually been exercised end-to-end until this investigation.
-- - provider_subscriptions: the webhook handler
--   (apps/web/app/api/webhooks/microsoft/calendar/route.ts) updates
--   last_notification_at via the service-role client. It never checked the
--   error, so this was failing silently — no real notification has ever
--   actually been recorded until this fix.

grant select, insert, update on public.calendar_connection_secrets to service_role;

grant select, insert on public.organizations to service_role;
grant select on public.roles to service_role;
grant select, insert on public.organization_memberships to service_role;
grant select, update on public.provider_subscriptions to service_role;
