import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { regenerateMeetingOutcome } from "@applywizz/domain/meeting-outcome-generation";
import { OpenRouterMeetingOutcomeProvider } from "@applywizz/ai";
import { getOpenRouterEnv, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Admin-only: force-regenerate Meeting Outcome (Overview cards) via the
 * Outcome LLM and overwrite meeting_outcomes for this meeting.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);

    if (membership.roleKey !== "admin") {
      return NextResponse.json(
        { error: "Only Admin can regenerate meeting outcomes." },
        { status: 403 },
      );
    }

    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (meetingError) throw meetingError;
    if (!meeting) {
      return NextResponse.json({ error: "Meeting not found." }, { status: 404 });
    }

    const clientEnv = getClientEnv();
    const openRouterEnv = getOpenRouterEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    const result = await regenerateMeetingOutcome(
      serviceRoleClient,
      id,
      new OpenRouterMeetingOutcomeProvider(openRouterEnv.OPENROUTER_API_KEY),
      { forceLlm: true },
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error(error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not regenerate meeting outcome.",
      },
      { status: 500 },
    );
  }
}
