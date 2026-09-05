-- department_id / team_id are deferred to M2 (Departments/Teams do not exist
-- yet). Adding placeholder FKs to non-existent tables now would mean either
-- fake entities or dangling references — the blueprint explicitly says not
-- to do that, so those columns are simply absent until M2 introduces the
-- tables they reference.
create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  work_email extensions.citext not null,
  display_name text not null,
  role_id uuid not null references public.roles (id),
  manager_membership_id uuid references public.organization_memberships (id),
  status public.membership_status not null default 'invited',
  meeting_ai_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deactivated_at timestamptz
);

create unique index organization_memberships_org_work_email_uq
  on public.organization_memberships (organization_id, work_email);

create index organization_memberships_manager_idx
  on public.organization_memberships (manager_membership_id);

create index organization_memberships_role_idx
  on public.organization_memberships (role_id);

-- A given auth user occupies at most one membership row overall (V1 has no
-- multi-organization membership).
create unique index organization_memberships_user_uq
  on public.organization_memberships (user_id)
  where user_id is not null;

create trigger organization_memberships_set_updated_at
  before update on public.organization_memberships
  for each row execute function public.set_updated_at();

-- Links a freshly authenticated Supabase Auth user to their profile and, if
-- an Admin already invited that work email, to their pending membership.
--
-- security definer + fixed search_path: this must run with elevated
-- privileges because it writes to organization_memberships on behalf of a
-- row that doesn't have a session yet (the INSERT trigger fires inside the
-- auth.users write itself), before any RLS-evaluable identity exists.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_membership_id uuid;
begin
  if new.email is null then
    return new;
  end if;

  insert into public.profiles (id, display_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;

  select id into v_membership_id
  from public.organization_memberships
  where lower(work_email) = lower(new.email)
    and user_id is null
    and status in ('invited', 'setup_required')
  order by created_at
  limit 1;

  if v_membership_id is not null then
    update public.organization_memberships
    set user_id = new.id,
        status = 'active'
    where id = v_membership_id;
  end if;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
