-- M10: human resolve/assign actions on M9's call_records. Same
-- authenticated-callable SECURITY DEFINER shape as the Customer Truth
-- RPCs (previous migration) — deliberately no service_role grant here
-- either, since no worker path resolves or reassigns operational items.

create or replace function private.assert_call_record_authorized(
  p_meeting_owner_membership_id uuid
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
    or p_meeting_owner_membership_id = v_actor
    or (
      private.has_permission('intelligence.read')
      and private.is_manager_of(v_actor, p_meeting_owner_membership_id)
    )
  then
    return;
  end if;

  raise exception 'Not authorized to act on this meeting''s call records.';
end;
$$;

create or replace function public.resolve_call_record(
  p_record_id uuid,
  p_resolution text,
  p_note text default null
)
returns public.call_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.call_records;
  v_owner_membership_id uuid;
begin
  if p_resolution not in ('completed', 'cancelled') then
    raise exception 'p_resolution must be ''completed'' or ''cancelled'', got %.', p_resolution;
  end if;

  select cr.* into v_record
    from public.call_records cr
    where cr.id = p_record_id and cr.organization_id = private.current_organization_id()
    for update of cr;

  if v_record.id is null then
    raise exception 'Call record not found.';
  end if;

  select owner_membership_id into v_owner_membership_id
    from public.meetings where id = v_record.meeting_id;

  perform private.assert_call_record_authorized(v_owner_membership_id);

  if v_record.status::text = p_resolution then
    return v_record; -- idempotent no-op: repeated resolve is safe
  end if;
  if v_record.status not in ('detected') then
    raise exception 'Cannot resolve a call record with status %.', v_record.status;
  end if;

  update public.call_records
  set status = p_resolution::public.call_record_status,
      resolved_by_membership_id = private.current_membership_id(),
      resolution_note = p_note,
      completed_at = now()
  where id = p_record_id and status = 'detected'
  returning * into v_record;

  if v_record.id is null then
    raise exception 'Call record was concurrently modified — please retry.';
  end if;

  insert into public.audit_events (organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_record.organization_id, 'user', auth.uid(),
    'call_record.' || p_resolution,
    'call_record', v_record.id,
    jsonb_build_object('recordType', v_record.record_type, 'note', p_note)
  );

  return v_record;
end;
$$;

create or replace function public.assign_call_record_owner(
  p_record_id uuid,
  p_owner_membership_id uuid,
  p_due_at timestamptz default null
)
returns public.call_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_record public.call_records;
  v_meeting_owner_membership_id uuid;
  v_new_owner_org uuid;
  v_new_owner_status public.membership_status;
begin
  select cr.* into v_record
    from public.call_records cr
    where cr.id = p_record_id and cr.organization_id = private.current_organization_id()
    for update of cr;

  if v_record.id is null then
    raise exception 'Call record not found.';
  end if;

  select owner_membership_id into v_meeting_owner_membership_id
    from public.meetings where id = v_record.meeting_id;

  perform private.assert_call_record_authorized(v_meeting_owner_membership_id);

  -- Codex plan review (BLOCKING #2): no existing trigger validates
  -- call_records.owner_membership_id's organization — a SECURITY DEFINER
  -- function bypasses RLS entirely, so this function itself must confirm
  -- the target membership is real, active, and in the SAME organization
  -- before assigning it, or a caller could point an operational item's
  -- ownership at a membership in a different org.
  select organization_id, status into v_new_owner_org, v_new_owner_status
    from public.organization_memberships
    where id = p_owner_membership_id;

  if v_new_owner_org is null or v_new_owner_org <> private.current_organization_id() then
    raise exception 'p_owner_membership_id must belong to the caller''s own organization.';
  end if;
  if v_new_owner_status <> 'active' then
    raise exception 'p_owner_membership_id must reference an active membership.';
  end if;

  update public.call_records
  set owner_membership_id = p_owner_membership_id,
      due_at = coalesce(p_due_at, due_at)
  where id = p_record_id
  returning * into v_record;

  insert into public.audit_events (organization_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (
    v_record.organization_id, 'user', auth.uid(), 'call_record.owner_assigned',
    'call_record', v_record.id,
    jsonb_build_object('ownerMembershipId', p_owner_membership_id, 'dueAt', p_due_at)
  );

  return v_record;
end;
$$;

revoke execute on function private.assert_call_record_authorized(uuid) from public, anon, authenticated, service_role;
grant execute on function private.assert_call_record_authorized(uuid) to authenticated;

revoke execute on function public.resolve_call_record(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.resolve_call_record(uuid, text, text) to authenticated;

revoke execute on function public.assign_call_record_owner(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.assign_call_record_owner(uuid, uuid, timestamptz) to authenticated;
