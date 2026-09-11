import { NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requirePermission } from "@applywizz/auth";
import type { Database } from "@applywizz/database/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type PolicySetUpdate = Database["public"]["Tables"]["meeting_policy_sets"]["Update"];

// Admin only (policy.manage). RLS (meeting_policy_sets_manage) is the
// actual org-scope enforcement — this only picks the row by id, RLS
// decides whether the caller may touch it.
export async function PATCH(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    await requirePermission(supabase, "policy.manage");
    const body = await request.json();

    if (!body.policySetId || typeof body.policySetId !== "string") {
      return NextResponse.json({ error: "policySetId is required." }, { status: 400 });
    }

    if (body.defaultDecision !== undefined && body.defaultDecision !== "record" && body.defaultDecision !== "exclude") {
      return NextResponse.json({ error: "defaultDecision must be 'record' or 'exclude'." }, { status: 400 });
    }
    if (
      body.cutoffMinutesBeforeStart !== undefined &&
      (typeof body.cutoffMinutesBeforeStart !== "number" ||
        !Number.isInteger(body.cutoffMinutesBeforeStart) ||
        body.cutoffMinutesBeforeStart < 0)
    ) {
      return NextResponse.json({ error: "cutoffMinutesBeforeStart must be a non-negative integer." }, { status: 400 });
    }
    if (
      body.botDispatchLeadSeconds !== undefined &&
      (typeof body.botDispatchLeadSeconds !== "number" ||
        !Number.isInteger(body.botDispatchLeadSeconds) ||
        body.botDispatchLeadSeconds < 0)
    ) {
      return NextResponse.json({ error: "botDispatchLeadSeconds must be a non-negative integer." }, { status: 400 });
    }

    const update: PolicySetUpdate = {};
    if (body.defaultDecision !== undefined) {
      update.default_decision = body.defaultDecision as PolicySetUpdate["default_decision"];
    }
    if (body.cutoffMinutesBeforeStart !== undefined) {
      update.cutoff_minutes_before_start = body.cutoffMinutesBeforeStart;
    }
    if (body.botDispatchLeadSeconds !== undefined) {
      update.bot_dispatch_lead_seconds = body.botDispatchLeadSeconds;
    }

    const { error } = await supabase.from("meeting_policy_sets").update(update).eq("id", body.policySetId);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error(error);
    return NextResponse.json({ error: "Could not update the policy." }, { status: 500 });
  }
}
