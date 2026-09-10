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

    if (
      !["account_manager", "manager", "senior_manager", "admin"].includes(
        membership.roleKey,
      )
    ) {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
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
      nextStep: typeof body.nextStep === "string" ? body.nextStep : undefined,
    });

    return NextResponse.json(result, { status: 200 });
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
