-- M5: meeting policy engine + do-not-record exception workflow. Locked
-- backend-schema doc's enums/tables, with three explicit, flagged
-- simplifications agreed before implementation (see the M5 design review):
--
-- 1. Blueprint priorities #11 ("explicit admin exclusion") and #12
--    ("approved recording exemption") are merged into ONE mechanism — an
--    approved recording_exemption_requests row, whoever initiated it.
--    Building a second raw admin-override path isn't something the
--    product requirement actually asked for.
-- 2. meeting_policy_rules has no `priority` column — the fixed
--    application code in packages/domain/src/meeting-policy.ts IS the
--    priority order (Codex's review: "use fixed application code for TRD
--    priority 8-16... avoid generic JSON predicates until admins need
--    rules the fixed list cannot name"). One source of truth instead of
--    a redundant, admin-editable-looking column that isn't actually
--    editable.
-- 3. meeting_policy_sets is one row per organization (a plain unique
--    index on organization_id, no versioning/is_default complexity) —
--    the brief's own "versioning if appropriate" hedge, and V1 has
--    nothing that needs more than one active configuration per org.
--
-- No production data exists anywhere yet (confirmed repeatedly across
-- M3/M4), so the meetings.eligibility_status type change below is a clean
-- conversion, not a backfill.

create type public.meeting_eligibility as enum ('pending', 'record', 'exclude', 'pending_exception', 'unsupported');
create type public.exemption_status as enum ('requested', 'approved', 'rejected', 'cancelled', 'expired');

alter table public.meetings
  alter column eligibility_status drop default,
  alter column eligibility_status type public.meeting_eligibility using eligibility_status::public.meeting_eligibility,
  alter column eligibility_status set default 'pending'::public.meeting_eligibility;

-- Needed to determine internal vs. external meeting attendees at all —
-- nothing else in this schema currently records "what is our own email
-- domain". Nullable: null means the internal/external rule_type simply
-- no-ops rather than misfiring on an unconfigured org.
alter table public.organizations
  add column email_domain text;

-- One row per organization. default_decision is what TRD priority #16
-- ("organization default policy") applies when nothing more specific
-- fired. cutoff_minutes_before_start drives resolveCutoffExceptions: an
-- unresolved 'requested' exemption is resolved to default_decision once
-- meetings.scheduled_start is within this many minutes (0 = right at
-- start). Computed dynamically against the meeting's CURRENT
-- scheduled_start at resolution time — deliberately not cached anywhere,
-- so a reschedule (M4's dedupe/reconciliation) can never leave a stale
-- cutoff behind.
create table public.meeting_policy_sets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null default 'Default Policy',
  default_decision public.meeting_eligibility not null default 'record',
  cutoff_minutes_before_start int not null default 0 check (cutoff_minutes_before_start >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index meeting_policy_sets_org_uq
  on public.meeting_policy_sets (organization_id);

create trigger meeting_policy_sets_set_updated_at
  before update on public.meeting_policy_sets
  for each row execute function public.set_updated_at();

-- Exactly nine fixed rule_types (TRD priority list items 8-16, minus
-- "organization default" which is meeting_policy_sets.default_decision
-- itself, not a toggle-able rule). enabled/params/reason_code are the
-- only admin-configurable surface — no generic condition language.
-- role_team and external_client ship present-but-inert in V1 (no
-- concrete team-selection or client-domain-list UI was requested) so a
-- later milestone can activate them without a new migration.
create table public.meeting_policy_rules (
  id uuid primary key default gen_random_uuid(),
  policy_set_id uuid not null references public.meeting_policy_sets (id) on delete cascade,
  rule_type text not null check (
    rule_type in (
      'organization_disabled',
      'employee_mi_disabled',
      'unsupported_mechanism',
      'admin_exclusion',
      'approved_exemption',
      'sensitive_internal',
      'role_team',
      'external_client',
      'org_default'
    )
  ),
  enabled boolean not null default true,
  params jsonb not null default '{}'::jsonb,
  reason_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index meeting_policy_rules_set_type_uq
  on public.meeting_policy_rules (policy_set_id, rule_type);

create trigger meeting_policy_rules_set_updated_at
  before update on public.meeting_policy_rules
  for each row execute function public.set_updated_at();

-- Append-only evaluation history — meetings.eligibility_status holds the
-- CURRENT decision, this table is the audit trail of every time
-- evaluateMeetingPolicy ran for a meeting. organization_id is
-- denormalized here deliberately (the exact lesson from M4's Codex
-- review, Finding #2: service-role code bypasses RLS entirely, so a
-- lookup/write table needs its own org boundary, not just a join through
-- meetings).
create table public.meeting_policy_decisions (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  policy_set_id uuid references public.meeting_policy_sets (id) on delete set null,
  decision public.meeting_eligibility not null,
  rule_type text,
  reason_code text not null,
  evaluated_at timestamptz not null default now(),
  context_snapshot jsonb not null default '{}'::jsonb
);

create index meeting_policy_decisions_meeting_evaluated_idx
  on public.meeting_policy_decisions (meeting_id, evaluated_at desc);

create index meeting_policy_decisions_org_idx
  on public.meeting_policy_decisions (organization_id);

-- The do-not-record exception workflow itself. organization_id
-- denormalized for the same reason as above. reason is DB-enforced
-- non-empty (mandatory reason isn't just a UI validation).
create table public.recording_exemption_requests (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  requested_by uuid not null references public.organization_memberships (id),
  reason text not null check (char_length(btrim(reason)) > 0),
  status public.exemption_status not null default 'requested',
  reviewed_by uuid references public.organization_memberships (id) on delete set null,
  review_notes text,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index recording_exemption_requests_meeting_status_idx
  on public.recording_exemption_requests (meeting_id, status);

create index recording_exemption_requests_org_idx
  on public.recording_exemption_requests (organization_id);

-- At most one live (requested) exemption request per meeting — prevents
-- duplicate concurrent requests for the same meeting.
create unique index recording_exemption_requests_one_pending_uq
  on public.recording_exemption_requests (meeting_id)
  where status = 'requested';

create trigger recording_exemption_requests_set_updated_at
  before update on public.recording_exemption_requests
  for each row execute function public.set_updated_at();

-- DB-enforced state integrity (not just app logic, and not just RLS —
-- Codex's M5 final review caught both of these as genuine gaps RLS alone
-- cannot close):
-- 1. A new request must always start life as 'requested' with no review
--    attached — otherwise an AM could insert a request that is already
--    'approved', skipping manager/admin review entirely.
-- 2. meeting_id/organization_id/requested_by/reason/requested_at are
--    immutable for the whole lifetime of a row — otherwise an authorized
--    reviewer could retarget an already-approved request onto a
--    different meeting by changing meeting_id while leaving status
--    untouched (the original trigger only fired when status itself
--    changed, so this slipped past it).
-- 3. Once a request leaves 'requested', it is terminal — no re-approval,
--    no re-rejection, no un-cancelling, and no quietly editing the
--    reviewer/notes/timestamp on a decided row either.
-- 4. Approving or rejecting always requires a reviewer identity — the
--    system-driven transitions (cancelled/expired) deliberately don't.
create or replace function public.validate_exemption_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'requested' then
      raise exception 'A new recording exemption request must start in status requested.';
    end if;
    if new.reviewed_by is not null or new.reviewed_at is not null or new.review_notes is not null then
      raise exception 'A new recording exemption request cannot already carry a review.';
    end if;
    return new;
  end if;

  if new.meeting_id is distinct from old.meeting_id
    or new.organization_id is distinct from old.organization_id
    or new.requested_by is distinct from old.requested_by
    or new.reason is distinct from old.reason
    or new.requested_at is distinct from old.requested_at then
    raise exception 'meeting_id, organization_id, requested_by, reason and requested_at cannot be changed after a recording exemption request is created.';
  end if;

  if old.status <> 'requested' and (
    new.status is distinct from old.status
    or new.reviewed_by is distinct from old.reviewed_by
    or new.reviewed_at is distinct from old.reviewed_at
    or new.review_notes is distinct from old.review_notes
  ) then
    raise exception 'Cannot change a decided recording exemption request (current status: %).', old.status;
  end if;

  if new.status in ('approved', 'rejected')
    and new.status is distinct from old.status
    and new.reviewed_by is null then
    raise exception 'Approving or rejecting a recording exemption request requires a reviewer.';
  end if;

  return new;
end;
$$;

create trigger recording_exemption_requests_validate_transition
  before insert or update on public.recording_exemption_requests
  for each row execute function public.validate_exemption_status_transition();
