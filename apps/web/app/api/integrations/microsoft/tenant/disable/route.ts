import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { disableTenantMicrosoft } from "@applywizz/domain/microsoft-tenant-connection";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    if (membership.roleKey !== "admin") {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }

    await disableTenantMicrosoft(supabase, {
      organizationId: membership.organizationId,
      actorUserId: membership.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not disable tenant-wide Microsoft sync." }, { status: 500 });
  }
}
