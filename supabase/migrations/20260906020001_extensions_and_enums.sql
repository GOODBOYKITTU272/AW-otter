-- Case-insensitive text for emails (work_email, profile email).
-- Installed into `extensions` (not `public`) per Supabase convention; table
-- definitions reference it as `extensions.citext`.
create extension if not exists citext with schema extensions;

-- Membership lifecycle. Do not scatter these values as ad-hoc strings —
-- application code mirrors this list in packages/domain.
create type public.membership_status as enum (
  'invited',
  'setup_required',
  'active',
  'suspended',
  'deactivated'
);

-- Canonical system role keys (blueprint TRD "Enums" section). The roles.key
-- column itself stays text (see 0002_roles_permissions.sql) so organization-
-- scoped custom roles remain possible in a later milestone; this enum is the
-- constraint that keeps *system* role keys limited to these four today.
create type public.role_key as enum (
  'admin',
  'senior_manager',
  'manager',
  'account_manager'
);
