-- M10: Customer Truth + Actions. Schema additions only — no RPCs yet
-- (those are the next two migrations). Codex plan review found 2
-- BLOCKING + 3 SHOULD-FIX issues in the original plan; every fix below
-- is called out at the exact point it addresses.

-- customer_truth_facts already has confirmed_by_membership_id/confirmed_at
-- (M7A) but no rejected equivalent — the user's required field list
-- ("confirmed/rejected_by, confirmed/rejected_at") needs both sides.
alter table public.customer_truth_facts
  add column rejected_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  add column rejected_at timestamptz,
  add column rejection_reason text;

-- Codex plan review (BLOCKING #1): a `select ... for update` on a row
-- that doesn't exist yet takes NO lock — two concurrent first-time
-- confirmations for the same (customer_id, field_key) could both see "no
-- prior confirmed fact" and both end up 'confirmed'. This unique partial
-- index is the real correctness backstop: confirm_customer_truth_fact
-- (next migration) supersedes whatever is currently confirmed via a
-- plain UPDATE, then confirms the target row — if a concurrent
-- transaction raced it, this constraint turns silent double-confirmation
-- into a real 23505 the caller must retry against, never silent
-- corruption. This also makes customer_truth_current's own `distinct on`
-- assumption (at most one confirmed row per field) a real enforced
-- invariant instead of just an assumed one.
create unique index customer_truth_facts_one_confirmed_per_field_uq
  on public.customer_truth_facts (customer_id, field_key)
  where status = 'confirmed';

-- Reuses the existing completed_at column for both 'completed' and
-- 'cancelled' terminal states (no separate cancelled_at) — resolution_note
-- covers a completion note or a dismissal reason, whichever applies.
alter table public.call_records
  add column resolved_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  add column resolution_note text;

-- Manager-scope SELECT visibility, mirroring meetings_select_manager_scope
-- (20260906020027) exactly. M7A explicitly deferred this on `customers`
-- ("no clean recursive-reporting-line RLS helper exists yet") — that
-- helper (private.is_manager_of) now exists, from M5.
create policy customers_select_manager_scope
  on public.customers
  for select
  to authenticated
  using (
    private.has_permission('intelligence.read')
    and organization_id = private.current_organization_id()
    and private.is_manager_of(private.current_membership_id(), owner_membership_id)
  );

create policy customer_truth_facts_select_manager_scope
  on public.customer_truth_facts
  for select
  to authenticated
  using (
    private.has_permission('intelligence.read')
    and organization_id = private.current_organization_id()
    and exists (
      select 1 from public.customers c
      where c.id = customer_truth_facts.customer_id
        and private.is_manager_of(private.current_membership_id(), c.owner_membership_id)
    )
  );

-- Codex plan review (SHOULD-FIX #1): call_records' existing SELECT policy
-- is meeting-scoped only, inheriting manager visibility transitively
-- through meetings_select_manager_scope — which is gated on
-- 'exceptions.approve', not 'intelligence.read'. That happens to work
-- today only because manager/senior_manager are seeded with BOTH
-- permissions together; it's a fragile coincidence, not a real
-- guarantee, and the M10 RPCs (next migration) need to check
-- 'intelligence.read' consistently with customer_truth_facts above. This
-- policy gives call_records its OWN direct manager-scope rule instead of
-- relying on that inherited, differently-gated one — decoupling it from
-- the unrelated exceptions-approval feature's own permission gate.
create policy call_records_select_manager_scope
  on public.call_records
  for select
  to authenticated
  using (
    private.has_permission('intelligence.read')
    and organization_id = private.current_organization_id()
    and exists (
      select 1 from public.meetings m
      where m.id = call_records.meeting_id
        and m.owner_membership_id is not null
        and private.is_manager_of(private.current_membership_id(), m.owner_membership_id)
    )
  );
