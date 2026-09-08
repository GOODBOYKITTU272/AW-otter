-- M7A RLS. Revoke-all-then-grant-back on every new table/view (M4's
-- learned convention — Supabase auto-grants TRUNCATE/REFERENCES/TRIGGER to
-- anon/authenticated by default, and service_role gets nothing implicit).
--
-- Manager/senior_manager direct-report visibility into customers is
-- DEFERRED here, same explicit call M4 made for meetings
-- (20260906020018: "no clean recursive-reporting-line RLS helper exists
-- yet... out of scope") and M2 made for people. Only AM-own and
-- Admin-org-wide exist in M7A.

revoke all on public.customers from anon, authenticated, service_role;
revoke all on public.customer_contacts from anon, authenticated, service_role;
revoke all on public.customer_truth_facts from anon, authenticated, service_role;

alter table public.customers enable row level security;
grant select, insert on public.customers to authenticated;
grant select, insert, update on public.customers to service_role;

create policy customers_select_own
  on public.customers
  for select
  to authenticated
  using (owner_membership_id = private.current_membership_id());

create policy customers_select_admin_org
  on public.customers
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- Codex plan review (BLOCKING #3): an authenticated insert must be pinned
-- to the caller's own organization explicitly — "owner is self or caller
-- is admin" alone doesn't stop an admin inserting into a DIFFERENT org.
-- Cross-org owner_membership_id misuse is additionally caught by the
-- validate_customer_org_consistency trigger (defense in depth: this
-- WITH CHECK is RLS-bound, the trigger also protects service_role writes
-- that bypass RLS entirely, e.g. a future seed script).
--
-- Codex plan review (SHOULD-FIX #7): source_type='manual' only for
-- authenticated inserts — 'fixture'/'future_import' are not user actions.
--
-- Codex post-implementation review (SHOULD-FIX): created_by_membership_id
-- must be the caller's own membership — it records who actually created
-- the row (distinct from owner_membership_id, who it's assigned to; an
-- Admin creating a customer for an AM is exactly the case these disagree).
create policy customers_insert_own_org
  on public.customers
  for insert
  to authenticated
  with check (
    organization_id = private.current_organization_id()
    and source_type = 'manual'
    and created_by_membership_id = private.current_membership_id()
    and (
      owner_membership_id = private.current_membership_id()
      or private.is_org_admin()
    )
  );

alter table public.customer_contacts enable row level security;
grant select, insert on public.customer_contacts to authenticated;
grant select, insert, update, delete on public.customer_contacts to service_role;

-- Visible exactly where the parent customer is (same shape as
-- meeting_attendees_select_visible in 20260906020018).
create policy customer_contacts_select_visible
  on public.customer_contacts
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_contacts.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or (private.is_org_admin() and c.organization_id = private.current_organization_id())
        )
    )
  );

create policy customer_contacts_insert_own_org
  on public.customer_contacts
  for insert
  to authenticated
  with check (
    organization_id = private.current_organization_id()
    and exists (
      select 1 from public.customers c
      where c.id = customer_contacts.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or private.is_org_admin()
        )
    )
  );

alter table public.customer_truth_facts enable row level security;
grant select, insert on public.customer_truth_facts to authenticated;
grant select, insert, update on public.customer_truth_facts to service_role;

create policy customer_truth_facts_select_visible
  on public.customer_truth_facts
  for select
  to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = customer_truth_facts.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or (private.is_org_admin() and c.organization_id = private.current_organization_id())
        )
    )
  );

-- Codex plan review (BLOCKING #2): an authenticated INSERT grant alone
-- does not stop a client-SDK caller from writing source_type='crm' or
-- 'meeting', fabricated evidence, or a non-'confirmed' status. M7A's
-- entire contract ("AI never silently changes Customer Truth", "no
-- onboarding integration built yet") has to be enforced here, not just
-- promised by the one route that's supposed to call this — WITH CHECK is
-- the actual enforcement.
create policy customer_truth_facts_insert_manual_seed
  on public.customer_truth_facts
  for insert
  to authenticated
  with check (
    organization_id = private.current_organization_id()
    and source_type in ('manual', 'onboarding_form')
    and status = 'confirmed'
    and source_meeting_id is null
    and evidence_segment_ids is null
    and confirmed_by_membership_id = private.current_membership_id()
    and exists (
      select 1 from public.customers c
      where c.id = customer_truth_facts.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or private.is_org_admin()
        )
    )
  );

-- customer_truth_current is a plain view (not a table) — nothing to
-- ALTER ... ENABLE ROW LEVEL SECURITY on. security_invoker (set in the
-- previous migration) plus a select grant is what makes it inherit
-- customer_truth_facts' own RLS instead of running as its owner.
grant select on public.customer_truth_current to authenticated, service_role;
