create or replace function private.is_manager_of(
  p_manager_membership_id uuid,
  p_employee_membership_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_manager_org uuid;
  v_employee_org uuid;
  v_current uuid;
  v_depth int := 0;
begin
  if p_manager_membership_id is null
    or p_employee_membership_id is null
    or p_manager_membership_id = p_employee_membership_id then
    return false;
  end if;

  select organization_id into v_manager_org
  from public.organization_memberships
  where id = p_manager_membership_id
    and status = 'active';

  select organization_id, manager_membership_id
  into v_employee_org, v_current
  from public.organization_memberships
  where id = p_employee_membership_id
    and status = 'active';

  if v_manager_org is null
    or v_employee_org is null
    or v_manager_org <> v_employee_org then
    return false;
  end if;

  while v_current is not null and v_depth < 50 loop
    if v_current = p_manager_membership_id then
      return true;
    end if;

    select manager_membership_id into v_current
    from public.organization_memberships
    where id = v_current
      and organization_id = v_employee_org
      and status = 'active';

    v_depth := v_depth + 1;
  end loop;

  return false;
end;
$$;

grant execute on function private.is_manager_of(uuid, uuid) to authenticated;
