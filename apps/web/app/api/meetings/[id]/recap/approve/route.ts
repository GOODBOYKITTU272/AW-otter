import { NextResponse } from "next/server";
import { getCurrentMembership, UnauthenticatedError } from "@applywizz/auth";
import { approveMeetingRecap } from "@applywizz/domain/meeting-recap";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);

    // Verify meeting visibility and ownership
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("id, organization_id, owner_membership_id")
      .eq("id", id)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json(
        { error: "Meeting not found or not accessible." },
        { status: 404 },
      );
    }

    // Blocker 2: Only responsible AM can approve the recap
    if (meeting.owner_membership_id !== membership.membershipId) {
      return NextResponse.json(
        {
          error:
            "Only the responsible Account Manager for this meeting is permitted to approve the recap.",
        },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = await approveMeetingRecap(supabase, {
      meetingId: id,
      actorUserId: membership.userId,
      actorMembershipId: membership.membershipId,
      greeting: typeof body.greeting === "string" ? body.greeting : undefined,
      agreements: Array.isArray(body.agreements) ? body.agreements : undefined,
      actions: Array.isArray(body.actions) ? body.actions : undefined,
      whatWeAgreed: Array.isArray(body.whatWeAgreed) ? body.whatWeAgreed : undefined,
      applyWizzWillDo: Array.isArray(body.applyWizzWillDo)
        ? body.applyWizzWillDo
        : undefined,
      customerShouldDo: Array.isArray(body.customerShouldDo)
        ? body.customerShouldDo
        : undefined,
      candidateShouldDo: Array.isArray(body.candidateShouldDo)
        ? body.candidateShouldDo
        : undefined,
      nextStep: typeof body.nextStep === "string" ? body.nextStep : undefined,
    });

    return NextResponse.json({ success: true, recap: result }, { status: 200 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "42501") {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not approve recap." },
      { status: 500 },
    );
  }
}

