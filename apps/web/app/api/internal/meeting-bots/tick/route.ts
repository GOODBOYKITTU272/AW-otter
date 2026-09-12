import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  processPendingBotJobs,
  reconcileOrganizationMeetingBots,
  syncBotStatuses,
  detectAndStopEndedMeetingBots,
} from "@applywizz/domain/meeting-bots";
import { processLiveAlerts } from "@applywizz/domain";
import { VexaMeetingBotProvider } from "@applywizz/meeting-bots";
import {
  getSupabaseServiceRoleKey,
  getVexaEnv,
  toVexaEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

// Same auth gate as every other /api/internal route. One combined tick —
// reconcile intent, schedule pending bots, sync live bot statuses — for
// every active organization. This IS the durable job/worker step
// (workers/orchestrator/bot-worker.mjs calls this same domain code
// directly on an interval); this route also serves as the M17B scheduled
// entry point (GET) and remains callable on demand (POST).
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
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

  // Phase-1 P1: Auto-leave detection - stop bots for ended meetings
  const autoLeaveResult = await detectAndStopEndedMeetingBots(
    serviceRoleClient,
    provider,
  );

  // Phase-1: Process live alerts for lobby stuck and customer missing
  const alertsResult = await processLiveAlerts(serviceRoleClient);

  return NextResponse.json(
    { reconcileResults, processResult, statusResult, autoLeaveResult, alertsResult },
    { status: 200 },
  );
}

export const GET = POST;
