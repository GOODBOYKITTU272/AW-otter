import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import type { PermissionKey, SystemRoleKey } from "@applywizz/domain";

export type AppSupabaseClient = SupabaseClient<Database>;

export class UnauthenticatedError extends Error {
  constructor() {
    super("No authenticated user.");
    this.name = "UnauthenticatedError";
  }
}

export class NoActiveMembershipError extends Error {
  constructor() {
    super("No active organization membership for this user.");
    this.name = "NoActiveMembershipError";
  }
}

export class ForbiddenError extends Error {
  readonly permission: PermissionKey;

  constructor(permission: PermissionKey) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

export interface CurrentMembership {
  membershipId: string;
  organizationId: string;
  userId: string;
  roleId: string;
  roleKey: string;
  displayName: string;
}

/** Throws UnauthenticatedError if there is no signed-in user on this client. */
export async function requireAuthenticatedUser(
  supabase: AppSupabaseClient,
): Promise<User> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new UnauthenticatedError();
  }
  return data.user;
}

/**
 * Resolves the caller's active membership. This is an app-layer convenience
 * only — Supabase RLS (supabase/migrations) is the actual security boundary
 * and enforces the same organization scoping independently.
 */
export async function getCurrentMembership(
  supabase: AppSupabaseClient,
): Promise<CurrentMembership> {
  const user = await requireAuthenticatedUser(supabase);

  const { data: membership, error: membershipError } = await supabase
    .from("organization_memberships")
    .select("id, organization_id, role_id, display_name")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError) throw membershipError;
  if (!membership) throw new NoActiveMembershipError();

  const { data: role, error: roleError } = await supabase
    .from("roles")
    .select("key")
    .eq("id", membership.role_id)
    .maybeSingle();

  if (roleError) throw roleError;

  return {
    membershipId: membership.id,
    organizationId: membership.organization_id,
    userId: user.id,
    roleId: membership.role_id,
    roleKey: role?.key ?? "",
    displayName: membership.display_name,
  };
}

/** Throws ForbiddenError if the caller's role lacks the given permission. */
export async function requirePermission(
  supabase: AppSupabaseClient,
  permission: PermissionKey,
): Promise<CurrentMembership> {
  const membership = await getCurrentMembership(supabase);

  const { data, error } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role_id", membership.roleId)
    .eq("permission_key", permission)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new ForbiddenError(permission);

  return membership;
}

export function isSystemRole(
  roleKey: string,
  allowed: readonly SystemRoleKey[],
): boolean {
  return (allowed as readonly string[]).includes(roleKey);
}
