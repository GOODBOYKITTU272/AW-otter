import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { unlinkMeeting } from "@applywizz/domain/customer-linkage";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// "Leave unlinked" — a deliberate, audited decision, not a no-op.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    await unlinkMeeting(supabase, serviceRoleClient, {
      meetingId: id,
      organizationId: membership.organizationId,
      actorMembershipId: membership.membershipId,
      actorRoleKey: membership.roleKey,
      actorUserId: membership.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof Error && /changed elsewhere/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof Error &&
      /not authorized to manage/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const pgError = error as { code?: string };
    if (pgError.code === "PGRST116") {
      return NextResponse.json(
        {
          error:
            "This meeting does not exist or you are not authorized to unlink it.",
        },
        { status: 403 },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not unlink the meeting." },
      { status: 500 },
    );
  }
}
