import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { runExceptionMaintenance } from "@applywizz/domain/recording-exceptions";
import { validateState } from "@applywizz/microsoft";
import { getInternalQueueSecret, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";

// Same secret-header gate as every other /api/internal route. Cancels
// exception requests whose meeting was cancelled and resolves any request
// past its org's cutoff to the org default — for every active
// organization. Called on demand for now, no scheduler yet.
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
      const result = await runExceptionMaintenance(serviceRoleClient, org.id);
      results.push({ organizationId: org.id, ...result });
    } catch (maintenanceError) {
      results.push({
        organizationId: org.id,
        error: maintenanceError instanceof Error ? maintenanceError.message : String(maintenanceError),
      });
    }
  }

  return NextResponse.json({ organizationsProcessed: results.length, results }, { status: 200 });
}
