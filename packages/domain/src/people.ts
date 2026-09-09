import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;
type MembershipRow =
  Database["public"]["Tables"]["organization_memberships"]["Row"];
type MembershipStatus = MembershipRow["status"];

export function normalizeWorkEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class DuplicateWorkEmailError extends Error {
  constructor() {
    super("A person with this work email already exists in this organization.");
    this.name = "DuplicateWorkEmailError";
  }
}

export class CrossOrganizationAssignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossOrganizationAssignmentError";
  }
}

export class SelfManagementError extends Error {
  constructor() {
    super("A person cannot manage themselves.");
    this.name = "SelfManagementError";
  }
}

export class CircularReportingError extends Error {
  constructor() {
    super(
      "This manager assignment would create a circular reporting relationship.",
    );
    this.name = "CircularReportingError";
  }
}

/**
 * Maps the database's own enforcement (unique constraint,
 * validate_membership_hierarchy trigger — supabase/migrations) onto typed
 * errors the UI can branch on. The database is the source of truth for
 * these rules; this is translation, not re-implementation.
 */
export function translatePersonError(error: PostgrestError): Error {
  if (error.code === "23505") {
    return new DuplicateWorkEmailError();
  }
  if (error.message.includes("cannot manage themselves")) {
    return new SelfManagementError();
  }
  if (error.message.includes("Circular reporting")) {
    return new CircularReportingError();
  }
  if (error.message.includes("must belong to the same organization")) {
    return new CrossOrganizationAssignmentError(error.message);
  }
  return new Error(error.message);
}

export interface CreatePersonInput {
  organizationId: string;
  workEmail: string;
  displayName: string;
  roleId: string;
  managerMembershipId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  meetingAiEnabled?: boolean;
}

export async function createPerson(
  supabase: AppSupabaseClient,
  input: CreatePersonInput,
): Promise<MembershipRow> {
  const { data, error } = await supabase
    .from("organization_memberships")
    .insert({
      organization_id: input.organizationId,
      work_email: normalizeWorkEmail(input.workEmail),
      display_name: input.displayName.trim(),
      role_id: input.roleId,
      manager_membership_id: input.managerMembershipId ?? null,
      department_id: input.departmentId ?? null,
      team_id: input.teamId ?? null,
      meeting_ai_enabled: input.meetingAiEnabled ?? true,
      status: "invited",
    })
    .select()
    .single();

  if (error) throw translatePersonError(error);
  return data;
}

/**
 * M17B: sends the real Supabase Auth invite for a just-created membership.
 * Must be called with a service_role client — `auth.admin.inviteUserByEmail`
 * is an admin-only API, unreachable from the RLS-scoped client `createPerson`
 * itself uses. Deliberately separate from `createPerson`: the membership
 * insert is the record of intent (and RLS-checkable via `people.manage`),
 * this is the side effect of actually reaching the person, done with the
 * narrowest possible privilege escalation (one call, not a wider
 * service-role client threaded through the whole request).
 *
 * Failure here is non-fatal to the caller's overall request — the
 * membership row itself is a real, useful, self-service-invitable record
 * either way (an admin can be shown that no invite went out and act on it),
 * not something to roll back over an email provider hiccup.
 */
export async function inviteMembership(
  serviceRoleClient: AppSupabaseClient,
  input: { workEmail: string; displayName: string; redirectTo: string },
): Promise<{ error: string | null }> {
  const { error } = await serviceRoleClient.auth.admin.inviteUserByEmail(
    normalizeWorkEmail(input.workEmail),
    {
      data: { display_name: input.displayName },
      redirectTo: input.redirectTo,
    },
  );
  return { error: error?.message ?? null };
}

export interface UpdatePersonInput {
  displayName?: string;
  roleId?: string;
  managerMembershipId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  meetingAiEnabled?: boolean;
  status?: MembershipStatus;
}

export async function updatePerson(
  supabase: AppSupabaseClient,
  membershipId: string,
  patch: UpdatePersonInput,
): Promise<MembershipRow> {
  const update: Database["public"]["Tables"]["organization_memberships"]["Update"] =
    {};
  if (patch.displayName !== undefined)
    update.display_name = patch.displayName.trim();
  if (patch.roleId !== undefined) update.role_id = patch.roleId;
  if (patch.managerMembershipId !== undefined)
    update.manager_membership_id = patch.managerMembershipId;
  if (patch.departmentId !== undefined)
    update.department_id = patch.departmentId;
  if (patch.teamId !== undefined) update.team_id = patch.teamId;
  if (patch.meetingAiEnabled !== undefined)
    update.meeting_ai_enabled = patch.meetingAiEnabled;
  // deactivated_at is set/cleared by the database (validate_membership_hierarchy
  // trigger, supabase/migrations) based on the status transition — not set here.
  if (patch.status !== undefined) update.status = patch.status;

  const { data, error } = await supabase
    .from("organization_memberships")
    .update(update)
    .eq("id", membershipId)
    .select()
    .single();

  if (error) throw translatePersonError(error);
  return data;
}

export function deactivateMembership(
  supabase: AppSupabaseClient,
  membershipId: string,
) {
  return updatePerson(supabase, membershipId, { status: "deactivated" });
}

export function assignManager(
  supabase: AppSupabaseClient,
  membershipId: string,
  managerMembershipId: string | null,
) {
  return updatePerson(supabase, membershipId, { managerMembershipId });
}

export function assignDepartment(
  supabase: AppSupabaseClient,
  membershipId: string,
  departmentId: string | null,
) {
  return updatePerson(supabase, membershipId, { departmentId });
}

export function assignTeam(
  supabase: AppSupabaseClient,
  membershipId: string,
  teamId: string | null,
) {
  return updatePerson(supabase, membershipId, { teamId });
}

export type ReportingValidation =
  { valid: true } | { valid: false; reason: string };

async function fetchManagerId(
  supabase: AppSupabaseClient,
  membershipRowId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("organization_memberships")
    .select("manager_membership_id")
    .eq("id", membershipRowId)
    .maybeSingle();
  if (error) throw error;
  const row: { manager_membership_id: string | null } | null = data;
  return row?.manager_membership_id ?? null;
}

/**
 * Read-only pre-check for immediate form feedback. The
 * validate_membership_hierarchy trigger (supabase/migrations) is the real,
 * unbypassable enforcement — this just avoids a round-trip error for the
 * common case by walking the same chain the trigger would.
 */
export async function validateReportingRelationship(
  supabase: AppSupabaseClient,
  membershipId: string,
  proposedManagerId: string | null,
): Promise<ReportingValidation> {
  if (!proposedManagerId) return { valid: true };
  if (proposedManagerId === membershipId) {
    return { valid: false, reason: "A person cannot manage themselves." };
  }

  let currentId: string | null = proposedManagerId;
  const maxDepth = 50;
  for (let depth = 0; currentId && depth < maxDepth; depth += 1) {
    if (currentId === membershipId) {
      return {
        valid: false,
        reason:
          "This manager assignment would create a circular reporting relationship.",
      };
    }
    currentId = await fetchManagerId(supabase, currentId);
  }

  return { valid: true };
}
