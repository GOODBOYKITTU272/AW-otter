import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { reconcileOrganizationCustomerLinkage } from "@applywizz/domain/customer-linkage";
import { validateState } from "@applywizz/microsoft";
import {
  getInternalQueueSecret,
  getSupabaseServiceRoleKey,
} from "@/env/server";
import { getClientEnv } from "@/env/client";

// Same secret-header gate as every other /api/internal route — not
// reachable by any authenticated app user. Runs customer-linkage
// reconciliation for every active organization; called on demand for now,
// no scheduler yet (same as every other reconciliation path in this app).
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
      const result = await reconcileOrganizationCustomerLinkage(
        serviceRoleClient,
        org.id,
      );
      results.push({ organizationId: org.id, ...result });
    } catch (reconcileError) {
      results.push({
        organizationId: org.id,
        error:
          reconcileError instanceof Error
            ? reconcileError.message
            : String(reconcileError),
      });
    }
  }

  return NextResponse.json(
    { organizationsProcessed: results.length, results },
    { status: 200 },
  );
}
