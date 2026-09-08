import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { linkMeetingToCustomer } from "@applywizz/domain/customer-linkage";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Manual link AND correction — same endpoint, same operation ("point this
// meeting at this customer"); linkMeetingToCustomer itself decides which
// audit action name applies. Authorization for READING the meeting/
// customer is RLS (an unauthorized id simply won't be visible, surfacing
// as PGRST116); the same-AM-ownership business rule and the CAS-guarded
// write conflict are linkMeetingToCustomer's own checks, not RLS's.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    const body = await request.json();

    if (!body.customerId || typeof body.customerId !== "string") {
      return NextResponse.json(
        { error: "customerId is required." },
        { status: 400 },
      );
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    await linkMeetingToCustomer(supabase, serviceRoleClient, {
      meetingId: id,
      organizationId: membership.organizationId,
      customerId: body.customerId,
      actorMembershipId: membership.membershipId,
      actorRoleKey: membership.roleKey,
      actorUserId: membership.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof Error && /owned by the same/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      /not authorized to manage/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof Error && /changed elsewhere/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const pgError = error as { code?: string };
    if (pgError.code === "PGRST116") {
      return NextResponse.json(
        {
          error:
            "This meeting or customer does not exist or you are not authorized to link it.",
        },
        { status: 403 },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not link the meeting." },
      { status: 500 },
    );
  }
}
