-- M10 amendment: CRM baseline snapshots — read-only external context,
-- kept structurally separate from the Signal-owned customer_truth_facts
-- ledger. "CRM says X" and "AM confirmed X from a meeting" are different
-- provenance classes and must never be conflated (locked requirement) —
-- this is why CRM data lands here, never as a synthetic 'confirmed'
-- customer_truth_facts row. Append-only snapshots (never updated/deleted
-- in place), same history-preserving posture as everything else in this
-- schema — a new row is only inserted when the normalized content
-- actually changed (content_fingerprint), never on every fetch.
--
-- normalized_data is the ALREADY-allowlisted output of
-- @applywizz/crm's normalizeCrmResponse — this table (and everything
-- downstream of it) never sees the raw upstream response or any field
-- outside that allowlist. That enforcement lives in the TypeScript
-- schema (packages/crm/src/types.ts), not here — this migration's job is
-- only to make sure nothing UNBOUNDED gets written (see the size check
-- constraint below, a defense-in-depth backstop).

create table public.customer_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  -- Denormalized copy of customers.external_applywizz_id at fetch time —
  -- kept even if the customer's own identity is later corrected, so a
  -- historical snapshot always shows what identity it was actually
  -- fetched under.
  external_applywizz_id text not null,
  normalized_data jsonb not null,
  -- Upstream's own last-modified timestamp, if it exposes one — never
  -- fabricated when absent.
  source_updated_at timestamptz,
  fetched_at timestamptz not null default now(),
  -- sha256 of normalized_data, used to skip inserting a new row when a
  -- fresh fetch returns byte-identical content (idempotent refresh).
  content_fingerprint text not null,
  source text not null default 'applywizz_crm',
  created_at timestamptz not null default now(),
  constraint customer_context_snapshots_no_duplicate_content
    unique (customer_id, content_fingerprint),
  -- Defense-in-depth backstop, not the real enforcement (that's the Zod
  -- allowlist) — catches a future accidental regression that starts
  -- writing something much larger than the allowlisted shape ever would.
  constraint customer_context_snapshots_bounded_size
    check (pg_column_size(normalized_data) < 16384)
);

create index customer_context_snapshots_latest_idx
  on public.customer_context_snapshots (customer_id, created_at desc);

create or replace function public.validate_customer_context_snapshot_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_org uuid;
begin
  select organization_id into v_customer_org
    from public.customers where id = new.customer_id;
  if v_customer_org is null or v_customer_org <> new.organization_id then
    raise exception 'customer_context_snapshots.customer_id must belong to the same organization.';
  end if;
  return new;
end;
$$;

create trigger customer_context_snapshots_validate_org
  before insert on public.customer_context_snapshots
  for each row execute function public.validate_customer_context_snapshot_org_consistency();

-- Same "visibility = can you see the customer" convention as
-- customer_truth_facts_select_visible/_manager_scope. No authenticated
-- write grant at all: hydration is server-triggered (an authenticated
-- action verifies visibility through the CALLER's own client first, then
-- the actual write goes through service_role — see
-- packages/domain/src/customer-context.ts) — same two-client pattern
-- already used by linkMeetingToCustomer/requestDoNotRecord.
revoke all on public.customer_context_snapshots from anon, authenticated, service_role;
alter table public.customer_context_snapshots enable row level security;
grant select on public.customer_context_snapshots to authenticated;
grant select, insert on public.customer_context_snapshots to service_role;

create policy customer_context_snapshots_select_visible
  on public.customer_context_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_context_snapshots.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or (private.is_org_admin() and c.organization_id = private.current_organization_id())
          or (
            private.has_permission('intelligence.read')
            and private.is_manager_of(private.current_membership_id(), c.owner_membership_id)
          )
        )
    )
  );
