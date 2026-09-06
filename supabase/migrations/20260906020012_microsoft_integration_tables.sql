-- M3: Microsoft calendar connection. Provider tokens are never stored in
-- this table (see calendar_connection_secrets below) — only safe,
-- non-secret metadata (granted scopes, connected account display
-- name/email as returned by the ID token, sync bookkeeping).
create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  organization_membership_id uuid not null references public.organization_memberships (id) on delete cascade,
  provider text not null default 'microsoft',
  provider_user_id text not null,
  status text not null default 'pending',
  scope_metadata jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One connection per (membership, provider): reconnecting updates the
-- existing row's status/tokens rather than inserting a second one.
create unique index calendar_connections_membership_provider_uq
  on public.calendar_connections (organization_membership_id, provider);

create index calendar_connections_provider_user_idx
  on public.calendar_connections (provider, provider_user_id);

create trigger calendar_connections_set_updated_at
  before update on public.calendar_connections
  for each row execute function public.set_updated_at();

-- Encrypted OAuth tokens, deliberately split into their own table so the
-- connection's status/metadata can be freely joined and displayed without
-- ever touching this one. Access tokens/refresh tokens are AES-256-GCM
-- encrypted (packages/microsoft) with the server-only ENCRYPTION_KEY before
-- being written here — this column never holds plaintext.
--
-- This table has NO RLS policies and NO grants to anon/authenticated at all
-- (see the M3 RLS migration) — only the service-role key can reach it, and
-- service_role already has implicit full access to public-schema tables
-- (the same trust boundary packages/database/src/server.ts's
-- createSupabaseServiceRoleClient documents). That is the "smallest secure
-- implementation" for M3; a dedicated secrets/KMS subsystem is not built.
create table public.calendar_connection_secrets (
  connection_id uuid primary key references public.calendar_connections (id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  access_token_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create trigger calendar_connection_secrets_set_updated_at
  before update on public.calendar_connection_secrets
  for each row execute function public.set_updated_at();

create table public.provider_subscriptions (
  id uuid primary key default gen_random_uuid(),
  calendar_connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  provider text not null default 'microsoft',
  external_subscription_id text not null unique,
  resource text not null,
  expires_at timestamptz not null,
  status text not null default 'active',
  last_notification_at timestamptz,
  last_renewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index provider_subscriptions_connection_idx
  on public.provider_subscriptions (calendar_connection_id);

create trigger provider_subscriptions_set_updated_at
  before update on public.provider_subscriptions
  for each row execute function public.set_updated_at();

-- Sync bookkeeping only (M3 proves connectivity) — not the M4 canonical
-- meeting reconciliation cursor.
create table public.calendar_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  calendar_connection_id uuid not null references public.calendar_connections (id) on delete cascade,
  cursor text,
  window_start timestamptz,
  window_end timestamptz,
  updated_at timestamptz not null default now()
);

create unique index calendar_sync_cursors_connection_uq
  on public.calendar_sync_cursors (calendar_connection_id);

create trigger calendar_sync_cursors_set_updated_at
  before update on public.calendar_sync_cursors
  for each row execute function public.set_updated_at();
