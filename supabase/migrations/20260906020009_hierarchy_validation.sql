-- Critical hierarchy validation. Runs regardless of which client performs
-- the write (authenticated app user or a future service-role script), so
-- this is the actual enforcement point — not the UI, not RLS (RLS governs
-- row visibility/ownership, not cross-table relationship consistency).
--
-- SECURITY DEFINER + fixed search_path so the checks see the true rows
-- being referenced (e.g. "manager belongs to a different org") rather than
-- whatever subset of rows RLS would let the calling role see, which would
-- make the error indistinguishable from "manager does not exist".
create or replace function public.validate_membership_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_manager_org uuid;
  v_department_org uuid;
  v_team_org uuid;
  v_current uuid;
  v_depth int := 0;
begin
  if new.manager_membership_id is not null then
    if new.manager_membership_id = new.id then
      raise exception 'A person cannot manage themselves.';
    end if;

    select organization_id into v_manager_org
    from public.organization_memberships
    where id = new.manager_membership_id;

    if v_manager_org is null or v_manager_org <> new.organization_id then
      raise exception 'Manager must belong to the same organization.';
    end if;

    -- Walk up the proposed manager's chain; if we ever reach this row's own
    -- id, assigning this manager would create a cycle. Depth cap is a
    -- sanity bound, not the primary defense — a real org hierarchy is a
    -- handful of levels deep, not 50.
    v_current := new.manager_membership_id;
    while v_current is not null and v_depth < 50 loop
      if v_current = new.id then
        raise exception 'Circular reporting relationship detected.';
      end if;
      select manager_membership_id into v_current
      from public.organization_memberships
      where id = v_current;
      v_depth := v_depth + 1;
    end loop;
  end if;

  if new.department_id is not null then
    select organization_id into v_department_org from public.departments where id = new.department_id;
    if v_department_org is null or v_department_org <> new.organization_id then
      raise exception 'Department must belong to the same organization.';
    end if;
  end if;

  if new.team_id is not null then
    select organization_id into v_team_org from public.teams where id = new.team_id;
    if v_team_org is null or v_team_org <> new.organization_id then
      raise exception 'Team must belong to the same organization.';
    end if;
  end if;

  -- deactivated_at tracks the status transition automatically, so every
  -- caller (UI, scripts, direct SQL) gets it right without having to
  -- remember to set it — and reactivating a person clears the stale
  -- timestamp rather than leaving a previous deactivation date in place.
  if new.status = 'deactivated' and (tg_op = 'INSERT' or old.status is distinct from 'deactivated') then
    new.deactivated_at := now();
  elsif new.status <> 'deactivated' and tg_op = 'UPDATE' and old.status = 'deactivated' then
    new.deactivated_at := null;
  end if;

  return new;
end;
$$;

create trigger organization_memberships_validate_hierarchy
  before insert or update on public.organization_memberships
  for each row execute function public.validate_membership_hierarchy();
