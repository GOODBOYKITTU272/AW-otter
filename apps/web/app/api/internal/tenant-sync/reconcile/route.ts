import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { reconcileTenantOrganization } from "@applywizz/domain/meetings";
import { validateState } from "@applywizz/microsoft";
import { getInternalQueueSecret, getMicrosoftEnv, getSupabaseServiceRoleKey, toMicrosoftEnv } from "@/env/server";
import { getClientEnv } from "@/env/client";

// Same secret-header gate as /api/internal/calendar-events/process — not
// reachable by any authenticated app user. Poll-only (no webhooks for the
// tenant-wide path, see reconcileTenantOrganization's own doc), so this is
// the only trigger for tenant sync — called on demand for now, same as
// every other reconciliation path in M4 (no scheduler yet).
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

  const { data: connections, error } = await serviceRoleClient
    .from("microsoft_tenant_connections")
    .select("organization_id, provider")
    .eq("status", "active");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const microsoftEnv = toMicrosoftEnv(getMicrosoftEnv());
  const results = [];
  for (const connection of connections ?? []) {
    try {
      const result = await reconcileTenantOrganization(serviceRoleClient, {
        organizationId: connection.organization_id,
        provider: connection.provider,
        microsoftEnv,
      });
      results.push({ organizationId: connection.organization_id, ...result });
    } catch (reconcileError) {
      results.push({
        organizationId: connection.organization_id,
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
    }
  }

  return NextResponse.json({ organizationsProcessed: results.length, results }, { status: 200 });
}
