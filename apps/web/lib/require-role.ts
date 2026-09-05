import { redirect } from "next/navigation";
import {
  getCurrentMembership,
  NoActiveMembershipError,
  UnauthenticatedError,
} from "@applywizz/auth";
import type { SystemRoleKey } from "@applywizz/domain";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The one place route-level authorization is checked. Every protected page
 * calls this instead of re-deriving membership/role logic itself.
 */
export async function requireRole(allowed: readonly SystemRoleKey[]) {
  const supabase = await getSupabaseServerClient();

  const membership = await getCurrentMembership(supabase).catch(
    (error: unknown) => {
      if (error instanceof UnauthenticatedError) redirect("/login");
      if (error instanceof NoActiveMembershipError) redirect("/access-pending");
      throw error;
    },
  );

  if (!(allowed as readonly string[]).includes(membership.roleKey)) {
    redirect("/access-pending");
  }

  return membership;
}
