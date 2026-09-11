import { redirect } from "next/navigation";
import {
  getCurrentMembership,
  NoActiveMembershipError,
  UnauthenticatedError,
} from "@applywizz/auth";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { LandingPage } from "@/components/landing-page";

/**
 * Root page that shows branded marketing landing for unauthenticated users.
 * Authenticated users are redirected to their role-based home route.
 */
export default async function RootPage() {
  const supabase = await getSupabaseServerClient();

  const roleKey = await getCurrentMembership(supabase)
    .then((membership) => membership.roleKey)
    .catch((error: unknown) => {
      if (error instanceof UnauthenticatedError) {
        // Show branded landing page for unauthenticated users
        return null;
      }
      if (error instanceof NoActiveMembershipError) redirect("/access-pending");
      throw error;
    });

  // Unauthenticated users see the landing page
  if (roleKey === null) {
    return <LandingPage />;
  }

  if (isSystemRoleKey(roleKey)) {
    redirect(ROLE_HOME_ROUTE[roleKey]);
  }
  redirect("/access-pending");
}
