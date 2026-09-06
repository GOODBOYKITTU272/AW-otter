import type { AppSupabaseClient } from "@applywizz/auth";

export interface PersonRow {
  id: string;
  workEmail: string;
  displayName: string;
  status: string;
  meetingAiEnabled: boolean;
  userLinked: boolean;
  roleId: string;
  roleName: string;
  managerId: string | null;
  managerName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  teamId: string | null;
  teamName: string | null;
  createdAt: string;
}

export interface OrgReferenceData {
  roles: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  teams: { id: string; name: string; departmentId: string | null }[];
  activeMembers: { id: string; displayName: string }[];
}

/**
 * Small lookup tables (roles/departments/teams/members), fetched once and
 * joined in application code rather than via nested selects — simpler to
 * type correctly than Supabase's embedded-resource generics, and cheap at
 * this scale (a handful to a few hundred rows per organization).
 */
export async function getOrgReferenceData(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<OrgReferenceData> {
  const [
    { data: roles, error: rolesError },
    { data: departments, error: deptError },
    { data: teams, error: teamError },
    { data: members, error: membersError },
  ] = await Promise.all([
    supabase
      .from("roles")
      .select("id, name")
      .or(`organization_id.eq.${organizationId},organization_id.is.null`),
    supabase
      .from("departments")
      .select("id, name")
      .eq("organization_id", organizationId),
    supabase
      .from("teams")
      .select("id, name, department_id")
      .eq("organization_id", organizationId),
    supabase
      .from("organization_memberships")
      .select("id, display_name")
      .eq("organization_id", organizationId)
      .eq("status", "active"),
  ]);

  if (rolesError) throw rolesError;
  if (deptError) throw deptError;
  if (teamError) throw teamError;
  if (membersError) throw membersError;

  return {
    roles: (roles ?? []).map((r) => ({ id: r.id, name: r.name })),
    departments: (departments ?? []).map((d) => ({ id: d.id, name: d.name })),
    teams: (teams ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      departmentId: t.department_id,
    })),
    activeMembers: (members ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name,
    })),
  };
}

export async function listPeople(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<PersonRow[]> {
  const [{ data: members, error }, reference] = await Promise.all([
    supabase
      .from("organization_memberships")
      .select("*")
      .eq("organization_id", organizationId)
      .order("display_name"),
    getOrgReferenceData(supabase, organizationId),
  ]);

  if (error) throw error;

  const roleMap = new Map(reference.roles.map((r) => [r.id, r.name]));
  const departmentMap = new Map(
    reference.departments.map((d) => [d.id, d.name]),
  );
  const teamMap = new Map(reference.teams.map((t) => [t.id, t.name]));
  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));

  return (members ?? []).map((m) => ({
    id: m.id,
    workEmail: m.work_email,
    displayName: m.display_name,
    status: m.status,
    meetingAiEnabled: m.meeting_ai_enabled,
    userLinked: m.user_id !== null,
    roleId: m.role_id,
    roleName: roleMap.get(m.role_id) ?? m.role_id,
    managerId: m.manager_membership_id,
    managerName: m.manager_membership_id
      ? (nameById.get(m.manager_membership_id) ?? null)
      : null,
    departmentId: m.department_id,
    departmentName: m.department_id
      ? (departmentMap.get(m.department_id) ?? null)
      : null,
    teamId: m.team_id,
    teamName: m.team_id ? (teamMap.get(m.team_id) ?? null) : null,
    createdAt: m.created_at,
  }));
}

export async function getPerson(
  supabase: AppSupabaseClient,
  membershipId: string,
): Promise<PersonRow | null> {
  const { data: member, error } = await supabase
    .from("organization_memberships")
    .select("*")
    .eq("id", membershipId)
    .maybeSingle();

  if (error) throw error;
  if (!member) return null;

  const reference = await getOrgReferenceData(supabase, member.organization_id);
  const roleMap = new Map(reference.roles.map((r) => [r.id, r.name]));
  const departmentMap = new Map(
    reference.departments.map((d) => [d.id, d.name]),
  );
  const teamMap = new Map(reference.teams.map((t) => [t.id, t.name]));

  let managerName: string | null = null;
  if (member.manager_membership_id) {
    const { data: manager } = await supabase
      .from("organization_memberships")
      .select("display_name")
      .eq("id", member.manager_membership_id)
      .maybeSingle();
    managerName = manager?.display_name ?? null;
  }

  return {
    id: member.id,
    workEmail: member.work_email,
    displayName: member.display_name,
    status: member.status,
    meetingAiEnabled: member.meeting_ai_enabled,
    userLinked: member.user_id !== null,
    roleId: member.role_id,
    roleName: roleMap.get(member.role_id) ?? member.role_id,
    managerId: member.manager_membership_id,
    managerName,
    departmentId: member.department_id,
    departmentName: member.department_id
      ? (departmentMap.get(member.department_id) ?? null)
      : null,
    teamId: member.team_id,
    teamName: member.team_id ? (teamMap.get(member.team_id) ?? null) : null,
    createdAt: member.created_at,
  };
}

export interface AuditEventRow {
  id: string;
  action: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  actorName: string | null;
}

export async function getPersonAuditEvents(
  supabase: AppSupabaseClient,
  membershipId: string,
): Promise<AuditEventRow[]> {
  const { data: events, error } = await supabase
    .from("audit_events")
    .select("*")
    .eq("entity_type", "organization_membership")
    .eq("entity_id", membershipId)
    .order("occurred_at", { ascending: false });

  if (error) throw error;

  const actorIds = [
    ...new Set(
      (events ?? [])
        .map((e) => e.actor_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const actorNameById = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("organization_memberships")
      .select("user_id, display_name")
      .in("user_id", actorIds);
    for (const actor of actors ?? []) {
      if (actor.user_id) actorNameById.set(actor.user_id, actor.display_name);
    }
  }

  return (events ?? []).map((e) => ({
    id: e.id,
    action: e.action,
    metadata: e.metadata as Record<string, unknown>,
    occurredAt: e.occurred_at,
    actorName: e.actor_id
      ? (actorNameById.get(e.actor_id) ?? "Unknown")
      : "System",
  }));
}
