import { NextResponse } from "next/server";
import { ForbiddenError, UnauthenticatedError, requirePermission } from "@applywizz/auth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Admin only (policy.manage). Toggles a single fixed rule_type's `enabled`
// flag — rule_type itself is fixed, seeded once by bootstrap_meeting_policy_set
// (M5 deliberately isn't an admin-editable condition language, see
// evaluateMeetingPolicy's own doc comment).
export async function PATCH(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    await requirePermission(supabase, "policy.manage");
    const body = await request.json();

    if (!body.policySetId || typeof body.policySetId !== "string") {
      return NextResponse.json({ error: "policySetId is required." }, { status: 400 });
    }
    if (!body.ruleType || typeof body.ruleType !== "string") {
      return NextResponse.json({ error: "ruleType is required." }, { status: 400 });
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean." }, { status: 400 });
    }

    const { error } = await supabase
      .from("meeting_policy_rules")
      .update({ enabled: body.enabled })
      .eq("policy_set_id", body.policySetId)
      .eq("rule_type", body.ruleType);
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
    return NextResponse.json({ error: "Could not update the rule." }, { status: 500 });
  }
}
