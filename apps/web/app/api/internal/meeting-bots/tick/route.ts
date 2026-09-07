import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  processPendingBotJobs,
  reconcileOrganizationMeetingBots,
  syncBotStatuses,
} from "@applywizz/domain/meeting-bots";
import { VexaMeetingBotProvider } from "@applywizz/meeting-bots";
import { validateState } from "@applywizz/microsoft";
import {
  getInternalQueueSecret,
  getSupabaseServiceRoleKey,
  getVexaEnv,
  toVexaEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";

// Same secret-header gate as every other /api/internal route. One
// combined tick — reconcile intent, schedule pending bots, sync live bot
// statuses — for every active organization. This IS the durable
// job/worker step (workers/orchestrator/bot-worker.mjs calls this same
// domain code directly on an interval); this route exists so the same
// tick can also be triggered on demand, matching every other M3-M5
// internal route's "no scheduler yet, called on demand" convention.
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

  let provider;
  try {
    provider = new VexaMeetingBotProvider(toVexaEnv(getVexaEnv()));
  } catch (envError) {
    return NextResponse.json(
      {
        error:
          envError instanceof Error
            ? envError.message
            : "Vexa is not configured.",
      },
      { status: 501 },
    );
  }

  const { data: organizations, error } = await serviceRoleClient
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const reconcileResults = [];
  for (const org of organizations ?? []) {
    try {
      const result = await reconcileOrganizationMeetingBots(
        serviceRoleClient,
        provider,
        org.id,
      );
      reconcileResults.push({ organizationId: org.id, ...result });
    } catch (reconcileError) {
      reconcileResults.push({
        organizationId: org.id,
        error:
          reconcileError instanceof Error
            ? reconcileError.message
            : String(reconcileError),
      });
    }
  }

  const processResult = await processPendingBotJobs(
    serviceRoleClient,
    provider,
  );
  const statusResult = await syncBotStatuses(serviceRoleClient, provider);

  return NextResponse.json(
    { reconcileResults, processResult, statusResult },
    { status: 200 },
  );
}
