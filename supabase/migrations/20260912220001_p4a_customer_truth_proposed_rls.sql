-- P4A: Echo Trust & Grounding — Authenticated Proposed Customer Truth RLS Policy
-- Allows Account Managers, Managers, and Admins to persist AI/Echo-proposed facts
-- strictly with status='proposed' and source_type='meeting'.
-- Enforces: "AI CAN PROPOSE. EVIDENCE CANNOT BE REWRITTEN. HUMANS APPROVE WHAT LEAVES THE COMPANY."

create policy customer_truth_facts_insert_proposed_meeting
  on public.customer_truth_facts
  for insert
  to authenticated
  with check (
    organization_id = private.current_organization_id()
    and source_type = 'meeting'
    and status = 'proposed'
    and source_meeting_id is not null
    and exists (
      select 1 from public.customers c
      where c.id = customer_truth_facts.customer_id
        and (
          c.owner_membership_id = private.current_membership_id()
          or private.is_org_admin()
          or (
            private.has_permission('intelligence.read')
            and private.is_manager_of(private.current_membership_id(), c.owner_membership_id)
          )
        )
    )
    and exists (
      select 1 from public.meetings m
      where m.id = customer_truth_facts.source_meeting_id
        and m.customer_id = customer_truth_facts.customer_id
        and m.organization_id = private.current_organization_id()
    )
  );
