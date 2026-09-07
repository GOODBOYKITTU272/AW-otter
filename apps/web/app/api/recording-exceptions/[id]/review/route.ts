import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { reviewException } from "@applywizz/domain/recording-exceptions";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Manager (in-scope, via private.is_manager_of) or Admin only. Authorization
// is enforced entirely by RLS (recording_exemption_requests_update_review) —
// an unauthorized caller's update matches zero rows, which surfaces here as
// a PostgREST "no rows" error on .single(), not a thrown permission error.
// Re-reviewing an already-decided request is blocked by the DB trigger
// (validate_exemption_status_transition, SQLSTATE P0001).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    const body = await request.json();

    if (body.decision !== "approved" && body.decision !== "rejected") {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'." }, { status: 400 });
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    await reviewException(supabase, serviceRoleClient, {
      requestId: id,
      organizationId: membership.organizationId,
      reviewerMembershipId: membership.membershipId,
      actorUserId: membership.userId,
      decision: body.decision,
      reviewNotes: typeof body.reviewNotes === "string" ? body.reviewNotes : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "PGRST116") {
      return NextResponse.json(
        { error: "This request does not exist or you are not authorized to review it." },
        { status: 403 },
      );
    }
    if (pgError.code === "P0001") {
      return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not review the request." }, { status: 500 });
  }
}
