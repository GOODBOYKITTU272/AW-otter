-- M7A: Customer Context Foundation WITHOUT a real CRM API (docs/product/
-- Signal_M7_Integration_Readiness_v1.md). Signal owns a minimal, temporary
-- customer directory: `external_crm_id` is nullable and never set to a
-- manual/fake value, so a future M7B CRM adapter can backfill it onto
-- these exact rows (same `id`) without touching any existing meeting,
-- call_record, or customer_truth_fact reference. Do not build M7B here.

-- 'external_scheduler': created automatically from a real ApplyWizz
-- scheduler-API call (see scheduler_calls table, migration 050001) — a
-- lead_id observed for the first time. Distinct from 'future_import',
-- which is reserved for a later bulk CRM backfill (M7B), not this
-- already-real, already-live read-only integration.
create type public.customer_source_type as enum (
  'manual',
  'fixture',
  'future_import',
  'external_scheduler'
);

create type public.customer_link_status as enum (
  'linked_auto',
  'linked_manual',
  'needs_link',
  'unlinked',
  'cancelled'
);

-- 'progress' (not 'day15_progress'): the scheduler API's PROGRESS_REVIEW
-- type is the source contract — it does not guarantee a Day-15 cadence
-- (today it usually lands near day 15; later it may not). "Day-15" is a
-- product/UI label applied to this value, never persisted as the value
-- itself (M7A revised-scheduler-integration decision).
create type public.call_type as enum (
  'discovery',
  'resume_review',
  'orientation',
  'progress',
  'renewal',
  'other_unknown'
);

-- Revised for the real scheduler-API integration (M7A revised plan).
-- 'external_scheduler': written automatically from a real scheduler-API
-- call_type value (scheduler_calls.canonical_call_type), never inferred.
-- 'am_confirmed': the AM explicitly confirmed/corrected it (may follow an
-- 'external_scheduler' value — the original external_type is preserved on
-- scheduler_calls, never destroyed).
-- 'manual': reserved for a call type set with no scheduler row at all
-- (not written anywhere yet in M7A).
-- 'future_import': reserved for M7B CRM backfill, not written yet.
create type public.call_type_source as enum (
  'external_scheduler',
  'am_confirmed',
  'manual',
  'future_import'
);

create type public.customer_truth_status as enum (
  'proposed',
  'confirmed',
  'rejected',
  'superseded'
);

-- 'meeting' (AI-detected, from a call) is a valid ledger value from day
-- one so the shape never needs to change when M9 exists, but nothing in
-- M7A ever writes it — no AI-detected Customer Truth path is built yet.
create type public.customer_truth_source_type as enum (
  'onboarding_form',
  'manual',
  'crm',
  'future_import',
  'meeting'
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  external_crm_id text,
  -- The scheduler API's `lead_id` (e.g. "AWL-6255") — the real, stable
  -- external customer identity (revised M7A plan). Nullable: a manually
  -- created customer has none. Never used as a lookup key interchangeably
  -- with contact email — a lead_id is the only thing allowed to resolve
  -- customer identity automatically; email is contact metadata/fallback
  -- only (see scheduler-linkage.ts).
  external_applywizz_id text,
  name text not null,
  owner_membership_id uuid not null references public.organization_memberships (id) on delete restrict,
  lifecycle_stage text,
  source_type public.customer_source_type not null default 'manual',
  created_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index customers_org_owner_idx on public.customers (organization_id, owner_membership_id);

-- Multiple NULLs never collide in a unique index (same reasoning as
-- customer_contacts_org_email_unique below) — only rows that actually have
-- an external_applywizz_id are constrained, so manual customers are
-- unaffected. This is the enforcement behind "same lead_id always resolves
-- to the same Signal customer; different lead_ids never silently merge."
create unique index customers_org_external_applywizz_id_uq
  on public.customers (organization_id, external_applywizz_id)
  where external_applywizz_id is not null;

-- external_crm_id has no uniqueness constraint yet — M7A never writes it,
-- and M7B's own reconciliation design (readiness doc §9) is what defines
-- how it gets backfilled safely. Adding a premature unique constraint now
-- would be exactly the kind of temporary-architecture-fights-the-real-CRM
-- risk this milestone exists to avoid.

create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  email extensions.citext not null,
  name text,
  created_at timestamptz not null default now(),
  -- The single trustworthy signal the whole linkage rule (§4) rests on:
  -- one contact email can only ever belong to one customer, org-wide. Not
  -- a nullable convenience column — organization_id is required specifically
  -- so this constraint doesn't need a join, and so it can never be
  -- silently widened by a null organization_id (NULLs don't collide in a
  -- unique index, which would defeat the whole point).
  constraint customer_contacts_org_email_unique unique (organization_id, email)
);

create index customer_contacts_customer_idx on public.customer_contacts (customer_id);

-- Append-only ledger (docs/product §6/§8 of both design docs). Never
-- updated in place — a confirmed fact's `previous_fact_id` points at the
-- fact it superseded, so history is never destroyed. M7A only ever writes
-- source_type in ('manual', 'onboarding_form') with status='confirmed' —
-- enforced by RLS's WITH CHECK (next migration), not just documented here.
create table public.customer_truth_facts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  field_key text not null,
  value jsonb not null,
  status public.customer_truth_status not null default 'proposed',
  previous_fact_id uuid references public.customer_truth_facts (id) on delete set null,
  source_type public.customer_truth_source_type not null,
  source_meeting_id uuid references public.meetings (id) on delete set null,
  source_speaker text,
  evidence_segment_ids uuid[],
  detected_at timestamptz not null default now(),
  confirmed_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create index customer_truth_facts_customer_field_idx
  on public.customer_truth_facts (customer_id, field_key, confirmed_at desc);

-- Current value per field. security_invoker so it evaluates RLS as the
-- querying role, not the view owner — it is not a separate authorization
-- surface, it must see exactly what customer_truth_facts' own RLS allows.
create view public.customer_truth_current
with (security_invoker = true) as
  select distinct on (customer_id, field_key) *
  from public.customer_truth_facts
  where status = 'confirmed'
  order by customer_id, field_key, confirmed_at desc;

-- Two org-consistency triggers, same shape as M6's
-- validate_meeting_bot_org_consistency: a denormalized organization_id
-- (kept for service_role's own org boundary, since service_role bypasses
-- RLS entirely) must never silently diverge from the row it references.

create or replace function public.validate_customer_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_org uuid;
  v_creator_org uuid;
begin
  select organization_id into v_owner_org
    from public.organization_memberships where id = new.owner_membership_id;
  if v_owner_org is null or v_owner_org <> new.organization_id then
    raise exception 'customers.owner_membership_id must belong to the same organization.';
  end if;

  if new.created_by_membership_id is not null then
    select organization_id into v_creator_org
      from public.organization_memberships where id = new.created_by_membership_id;
    if v_creator_org is null or v_creator_org <> new.organization_id then
      raise exception 'customers.created_by_membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger customers_validate_org
  before insert or update on public.customers
  for each row execute function public.validate_customer_org_consistency();

create or replace function public.validate_customer_child_org_consistency()
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
    raise exception 'organization_id must match the referenced customer''s organization_id.';
  end if;
  return new;
end;
$$;

create trigger customer_contacts_validate_org
  before insert or update on public.customer_contacts
  for each row execute function public.validate_customer_child_org_consistency();

create trigger customer_truth_facts_validate_org
  before insert or update on public.customer_truth_facts
  for each row execute function public.validate_customer_child_org_consistency();
