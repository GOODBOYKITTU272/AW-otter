-- M10: human confirm/reject actions on Customer Truth. First
-- SECURITY DEFINER functions in this schema callable DIRECTLY by
-- `authenticated` — every prior RPC (M4-M9) was service_role/worker-only.
-- Deliberately NOT granted to service_role at all: the locked M10 rule is
-- "no service-role or worker path ever auto-confirms one" — AI may only
-- ever leave a fact 'proposed' (materialize_customer_truth_deltas, M9);
-- only these two functions can ever move it further.

create or replace function private.assert_customer_truth_authorized(
  p_customer_owner_membership_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_actor uuid;
begin
  v_actor := private.current_membership_id();
  if v_actor is null then
    raise exception 'No active membership for the current user.';
  end if;

  if private.is_org_admin()
    or p_customer_owner_membership_id = v_actor
    or (
      private.has_permission('intelligence.read')
      and private.is_manager_of(v_actor, p_customer_owner_membership_id)
    )
  then
    return;
  end if;

  raise exception 'Not authorized to act on this customer''s Customer Truth.';
end;
$$;

create or replace function public.confirm_customer_truth_fact(p_fact_id uuid)
returns public.customer_truth_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.customer_truth_facts;
  v_owner_membership_id uuid;
  v_superseded_id uuid;
begin
  -- Codex plan review (SHOULD-FIX #3): org-scope the lookup itself so a
  -- cross-org id is indistinguishable from "not found" — never a
  -- separate "exists but forbidden" code path.
  select f.* into v_fact
    from public.customer_truth_facts f
    where f.id = p_fact_id and f.organization_id = private.current_organization_id()
    for update of f;

  if v_fact.id is null then
    raise exception 'Customer Truth fact not found.';
  end if;

  select owner_membership_id into v_owner_membership_id
    from public.customers where id = v_fact.customer_id;

  perform private.assert_customer_truth_authorized(v_owner_membership_id);

  if v_fact.status = 'confirmed' then
    return v_fact; -- idempotent no-op: repeated confirm is safe, no new audit row
  end if;
  if v_fact.status <> 'proposed' then
    raise exception 'Cannot confirm a fact with status %.', v_fact.status;
  end if;

  -- Atomically supersede whatever is currently confirmed for this field
  -- (0 or 1 rows — enforced by customer_truth_facts_one_confirmed_per_field_uq).
  update public.customer_truth_facts
  set status = 'superseded'
  where customer_id = v_fact.customer_id
    and field_key = v_fact.field_key
    and status = 'confirmed'
  returning id into v_superseded_id;

  update public.customer_truth_facts
  set status = 'confirmed',
      previous_fact_id = v_superseded_id,
      confirmed_by_membership_id = private.current_membership_id(),
      confirmed_at = now()
  where id = p_fact_id and status = 'proposed'
  returning * into v_fact;

  if v_fact.id is null then
    -- Lost a genuine race to a concurrent confirm/reject of this exact
    -- fact between the initial lock and here — surface it, don't guess.
    raise exception 'Customer Truth fact was concurrently modified — please retry.';
  end if;

  insert into public.audit_events (organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_fact.organization_id, 'user', auth.uid(), 'customer_truth.confirmed',
    'customer_truth_fact', v_fact.id,
    jsonb_build_object('fieldKey', v_fact.field_key, 'supersededFactId', v_superseded_id)
  );

  return v_fact;
end;
$$;

create or replace function public.reject_customer_truth_fact(
  p_fact_id uuid,
  p_reason text default null
)
returns public.customer_truth_facts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fact public.customer_truth_facts;
  v_owner_membership_id uuid;
begin
  select f.* into v_fact
    from public.customer_truth_facts f
    where f.id = p_fact_id and f.organization_id = private.current_organization_id()
    for update of f;

  if v_fact.id is null then
    raise exception 'Customer Truth fact not found.';
  end if;

  select owner_membership_id into v_owner_membership_id
    from public.customers where id = v_fact.customer_id;

  perform private.assert_customer_truth_authorized(v_owner_membership_id);

  if v_fact.status = 'rejected' then
    return v_fact; -- idempotent no-op
  end if;
  if v_fact.status <> 'proposed' then
    raise exception 'Cannot reject a fact with status %.', v_fact.status;
  end if;

  update public.customer_truth_facts
  set status = 'rejected',
      rejected_by_membership_id = private.current_membership_id(),
      rejected_at = now(),
      rejection_reason = p_reason
  where id = p_fact_id and status = 'proposed'
  returning * into v_fact;

  if v_fact.id is null then
    raise exception 'Customer Truth fact was concurrently modified — please retry.';
  end if;

  insert into public.audit_events (organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_fact.organization_id, 'user', auth.uid(), 'customer_truth.rejected',
    'customer_truth_fact', v_fact.id,
    jsonb_build_object('fieldKey', v_fact.field_key, 'reason', p_reason)
  );

  return v_fact;
end;
$$;

-- PostgreSQL grants EXECUTE to PUBLIC by default, and (per the real M9 CI
-- incident on commit 4008b44) a given Postgres image's own baseline setup
-- may ALSO grant `authenticated` a direct entry that revoking PUBLIC alone
-- won't remove — every role is named explicitly here, matching the fix
-- already shipped in aacaa8a.
revoke execute on function private.assert_customer_truth_authorized(uuid) from public, anon, authenticated, service_role;
grant execute on function private.assert_customer_truth_authorized(uuid) to authenticated;

revoke execute on function public.confirm_customer_truth_fact(uuid) from public, anon, authenticated, service_role;
grant execute on function public.confirm_customer_truth_fact(uuid) to authenticated;

revoke execute on function public.reject_customer_truth_fact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.reject_customer_truth_fact(uuid, text) to authenticated;
