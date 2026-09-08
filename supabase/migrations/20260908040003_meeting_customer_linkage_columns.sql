-- M7A: extend meetings with customer linkage + AM-confirmed call type.
-- No RLS changes needed here — these are new columns on an existing row,
-- meetings visibility is unchanged; the existing service_role
-- select/insert/update grant (20260906020018) already covers writing them.
-- Writes still go through service_role only, same as every other meetings
-- write (queue/reconciliation-driven, or a human action verified via the
-- caller's own authenticated client first — see customer-linkage.ts).

alter table public.meetings
  add column customer_id uuid references public.customers (id) on delete set null,
  add column customer_link_status public.customer_link_status,
  add column needs_link_reason text,
  add column linked_at timestamptz,
  add column linked_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  add column call_type public.call_type,
  add column call_type_source public.call_type_source,
  add column call_type_confirmed_by_membership_id uuid references public.organization_memberships (id) on delete set null,
  add column call_type_confirmed_at timestamptz;

create index meetings_customer_id_idx on public.meetings (customer_id) where customer_id is not null;

create index meetings_customer_link_status_idx
  on public.meetings (organization_id, customer_link_status)
  where customer_link_status = 'needs_link';

-- Codex plan review (SHOULD-FIX #5): commit to one trigger now rather than
-- deciding during implementation. Same shape as M6's
-- validate_meeting_bot_org_consistency, but meetings.customer_id is the
-- inverse direction (meetings referencing customers, not a child table
-- referencing meetings) — also validates the two membership FKs this
-- migration adds are same-org when set, since neither is covered by any
-- existing trigger.
create or replace function public.validate_meeting_customer_org_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_org uuid;
  v_linked_by_org uuid;
  v_confirmer_org uuid;
begin
  if new.customer_id is not null then
    select organization_id into v_customer_org from public.customers where id = new.customer_id;
    if v_customer_org is null or v_customer_org <> new.organization_id then
      raise exception 'meetings.customer_id must belong to the same organization.';
    end if;
  end if;

  if new.linked_by_membership_id is not null then
    select organization_id into v_linked_by_org
      from public.organization_memberships where id = new.linked_by_membership_id;
    if v_linked_by_org is null or v_linked_by_org <> new.organization_id then
      raise exception 'meetings.linked_by_membership_id must belong to the same organization.';
    end if;
  end if;

  if new.call_type_confirmed_by_membership_id is not null then
    select organization_id into v_confirmer_org
      from public.organization_memberships where id = new.call_type_confirmed_by_membership_id;
    if v_confirmer_org is null or v_confirmer_org <> new.organization_id then
      raise exception 'meetings.call_type_confirmed_by_membership_id must belong to the same organization.';
    end if;
  end if;

  return new;
end;
$$;

create trigger meetings_validate_customer_org
  before insert or update on public.meetings
  for each row execute function public.validate_meeting_customer_org_consistency();
