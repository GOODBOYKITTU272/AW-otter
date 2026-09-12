/**
 * Single source of truth for the enum-like values defined in the backend
 * schema (supabase/migrations). Keep in sync with:
 * - public.membership_status
 * - public.role_key
 * - public.permissions seed rows
 */

export const MEMBERSHIP_STATUSES = [
  "invited",
  "setup_required",
  "active",
  "suspended",
  "deactivated",
] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const SYSTEM_ROLE_KEYS = [
  "admin",
  "senior_manager",
  "manager",
  "account_manager",
] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export function isSystemRoleKey(value: string): value is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}

export const PERMISSION_KEYS = [
  "organization.manage",
  "people.manage",
  "policy.manage",
  "meetings.read",
  "transcripts.read",
  "intelligence.read",
  "exceptions.approve",
  "audit.read",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Where a role lands after sign-in. M1 destinations are placeholder pages. */
export const ROLE_HOME_ROUTE: Record<SystemRoleKey, string> = {
  admin: "/admin/overview",
  senior_manager: "/manager/overview",
  manager: "/manager/overview",
  account_manager: "/home",
};

export * from "./live-alerts";
