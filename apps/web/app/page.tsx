import { redirect } from "next/navigation";
import {
  getCurrentMembership,
  NoActiveMembershipError,
  UnauthenticatedError,
} from "@applywizz/auth";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/** Resolves the signed-in user's role and sends them to their home route. */
export default async function RootPage() {
  const supabase = await getSupabaseServerClient();

  const roleKey = await getCurrentMembership(supabase)
    .then((membership) => membership.roleKey)
    .catch((error: unknown) => {
      if (error instanceof UnauthenticatedError) redirect("/login");
      if (error instanceof NoActiveMembershipError) redirect("/access-pending");
      throw error;
    });

  if (isSystemRoleKey(roleKey)) {
    redirect(ROLE_HOME_ROUTE[roleKey]);
  }
  redirect("/access-pending");
}
