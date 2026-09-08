import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { confirmCallType } from "@applywizz/domain/customer-linkage";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import type { Database } from "@applywizz/database/types";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const VALID_CALL_TYPES = [
  "discovery",
  "resume_review",
  "orientation",
  "progress",
  "renewal",
  "other_unknown",
] as const satisfies readonly Database["public"]["Enums"]["call_type"][];

// Never inferred — the AM always explicitly confirms one of the fixed
// values above.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    const body = await request.json();

    if (!VALID_CALL_TYPES.includes(body.callType)) {
      return NextResponse.json(
        { error: `callType must be one of: ${VALID_CALL_TYPES.join(", ")}` },
        { status: 400 },
      );
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    await confirmCallType(supabase, serviceRoleClient, {
      meetingId: id,
      organizationId: membership.organizationId,
      callType: body.callType,
      actorMembershipId: membership.membershipId,
      actorRoleKey: membership.roleKey,
      actorUserId: membership.userId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof Error && /link this meeting/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
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
            "This meeting does not exist or you are not authorized to confirm its call type.",
        },
        { status: 403 },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not confirm the call type." },
      { status: 500 },
    );
  }
}
