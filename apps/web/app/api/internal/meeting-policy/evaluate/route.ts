import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { evaluateOrganizationMeetings } from "@applywizz/domain/meeting-policy";
import { validateState } from "@applywizz/microsoft";
import { getInternalQueueSecret, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";

// Same secret-header gate as every other /api/internal route — not
// reachable by any authenticated app user. Runs policy evaluation for
// every active organization; called on demand for now, no scheduler yet
// (same as M4's reconciliation paths).
export async function POST(request: NextRequest) {
  const provided = request.headers.get("x-internal-queue-secret");
  if (!validateState(provided, getInternalQueueSecret())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  const { data: organizations, error } = await serviceRoleClient
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = [];
  for (const org of organizations ?? []) {
    try {
      const result = await evaluateOrganizationMeetings(serviceRoleClient, org.id);
      results.push({ organizationId: org.id, ...result });
    } catch (evalError) {
      results.push({
        organizationId: org.id,
        error: evalError instanceof Error ? evalError.message : String(evalError),
      });
    }
  }

  return NextResponse.json({ organizationsProcessed: results.length, results }, { status: 200 });
}
