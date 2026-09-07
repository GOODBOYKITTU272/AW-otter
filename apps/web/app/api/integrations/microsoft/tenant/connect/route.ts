import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { connectTenantMicrosoft } from "@applywizz/domain/microsoft-tenant-connection";
import { getMicrosoftEnv, toMicrosoftEnv } from "@/env/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Admin-only — enforced by RLS (microsoft_tenant_connections_admin_insert),
// not just this app-layer check, matching this project's "RLS is the sole
// security boundary" convention. A non-admin's request fails at the
// database, not just here.
export async function POST() {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    if (membership.roleKey !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    await connectTenantMicrosoft(supabase, {
      organizationId: membership.organizationId,
      connectedByMembershipId: membership.membershipId,
      actorUserId: membership.userId,
      microsoftEnv: toMicrosoftEnv(getMicrosoftEnv()),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not enable tenant-wide Microsoft sync." }, { status: 500 });
  }
}
