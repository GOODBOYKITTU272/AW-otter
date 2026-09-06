-- Minimal audit mechanism for M2 only — just enough for Person Detail's
-- "Recent Activity" (hierarchy/account events). This is NOT the full audit
-- product from the blueprint's M15 milestone: no audit log UI, no coverage
-- of policy/exception/external-delivery events, no "manager: limited if
-- granted" visibility tier (RLS matrix) — those remain M15's job. Columns
-- match the blueprint's locked audit_events catalog so M15 can extend this
-- table rather than replace it.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_type text not null default 'user',
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index audit_events_org_occurred_idx on public.audit_events (organization_id, occurred_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id);

alter table public.audit_events enable row level security;
grant select on public.audit_events to authenticated;

-- M2 visibility: admin only, own org. The blueprint's RLS matrix also wants
-- a manager "limited if granted" tier — deferred to M15 alongside the rest
-- of the audit product.
create policy audit_events_select_admin_org
  on public.audit_events
  for select
  to authenticated
  using (
    private.is_org_admin()
    and organization_id = private.current_organization_id()
  );

-- No insert/update/delete policy for authenticated: every audit row is
-- written by the SECURITY DEFINER trigger below, which bypasses RLS as the
-- function owner — never by direct client writes.
create or replace function public.audit_membership_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
    values (
      new.organization_id,
      auth.uid(),
      'membership.created',
      'organization_membership',
      new.id,
      jsonb_build_object('work_email', new.work_email, 'role_id', new.role_id, 'status', new.status)
    );
    return new;
  end if;

  if new.display_name is distinct from old.display_name then
    v_changes := v_changes || jsonb_build_object('display_name', jsonb_build_object('from', old.display_name, 'to', new.display_name));
  end if;
  if new.role_id is distinct from old.role_id then
    v_changes := v_changes || jsonb_build_object('role_id', jsonb_build_object('from', old.role_id, 'to', new.role_id));
  end if;
  if new.manager_membership_id is distinct from old.manager_membership_id then
    v_changes := v_changes || jsonb_build_object('manager_membership_id', jsonb_build_object('from', old.manager_membership_id, 'to', new.manager_membership_id));
  end if;
  if new.department_id is distinct from old.department_id then
    v_changes := v_changes || jsonb_build_object('department_id', jsonb_build_object('from', old.department_id, 'to', new.department_id));
  end if;
  if new.team_id is distinct from old.team_id then
    v_changes := v_changes || jsonb_build_object('team_id', jsonb_build_object('from', old.team_id, 'to', new.team_id));
  end if;
  if new.meeting_ai_enabled is distinct from old.meeting_ai_enabled then
    v_changes := v_changes || jsonb_build_object('meeting_ai_enabled', jsonb_build_object('from', old.meeting_ai_enabled, 'to', new.meeting_ai_enabled));
  end if;
  if new.status is distinct from old.status then
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status));
  end if;

  if v_changes = '{}'::jsonb then
    return new;
  end if;

  v_action := case when new.status = 'deactivated' and old.status is distinct from 'deactivated'
    then 'membership.deactivated'
    else 'membership.updated'
  end;

  insert into public.audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
  values (new.organization_id, auth.uid(), v_action, 'organization_membership', new.id, v_changes);

  return new;
end;
$$;

create trigger organization_memberships_audit
  after insert or update on public.organization_memberships
  for each row execute function public.audit_membership_changes();
