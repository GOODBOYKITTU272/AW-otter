import { NextResponse } from "next/server";
import { getCurrentMembership, UnauthenticatedError } from "@applywizz/auth";
import { saveMeetingRecapDraft } from "@applywizz/domain/meeting-recap";
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

    // Blocker 2: Only responsible AM can save draft or mark ready for review
    if (meeting.owner_membership_id !== membership.membershipId) {
      return NextResponse.json(
        {
          error:
            "Only the responsible Account Manager for this meeting is permitted to modify the recap.",
        },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const result = await saveMeetingRecapDraft(supabase, {
      meetingId: id,
      actorMembershipId: membership.membershipId,
      greeting: typeof body.greeting === "string" ? body.greeting : "",
      whatWeAgreed: Array.isArray(body.whatWeAgreed) ? body.whatWeAgreed : [],
      applyWizzWillDo: Array.isArray(body.applyWizzWillDo)
        ? body.applyWizzWillDo
        : [],
      candidateShouldDo: Array.isArray(body.candidateShouldDo)
        ? body.candidateShouldDo
        : [],
      nextStep: typeof body.nextStep === "string" ? body.nextStep : "",
      status:
        body.status === "ready_for_review" ? "ready_for_review" : "draft",
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
      { error: "Could not save recap draft." },
      { status: 500 },
    );
  }
}
