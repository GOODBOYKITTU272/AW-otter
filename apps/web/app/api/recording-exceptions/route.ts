import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { requestDoNotRecord } from "@applywizz/domain/recording-exceptions";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// AM-initiated "Request not to record" — deliberately not a toggle. RLS
// (recording_exemption_requests_insert_own) enforces "only for a meeting
// you own"; requestDoNotRecord enforces the mandatory reason. Both fold
// into the same 403/400 here.
export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    const body = await request.json();

    if (!body.meetingId || typeof body.meetingId !== "string") {
      return NextResponse.json({ error: "meetingId is required." }, { status: 400 });
    }
    if (!body.reason || typeof body.reason !== "string" || body.reason.trim().length === 0) {
      return NextResponse.json({ error: "A reason is required to request not to record." }, { status: 400 });
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    const result = await requestDoNotRecord(supabase, serviceRoleClient, {
      meetingId: body.meetingId,
      organizationId: membership.organizationId,
      requestedByMembershipId: membership.membershipId,
      actorUserId: membership.userId,
      reason: body.reason,
    });

    return NextResponse.json({ requestId: result.requestId }, { status: 201 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof Error && /reason is required/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "42501") {
      return NextResponse.json(
        { error: "You can only request not to record a meeting you own." },
        { status: 403 },
      );
    }
    if (pgError.code === "23505") {
      return NextResponse.json(
        { error: "This meeting already has a pending request." },
        { status: 409 },
      );
    }
    console.error(error);
    return NextResponse.json({ error: "Could not submit the request." }, { status: 500 });
  }
}
