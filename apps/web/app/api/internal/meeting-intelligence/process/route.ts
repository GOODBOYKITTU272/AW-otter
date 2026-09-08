import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  enqueuePendingIntelligenceRuns,
  materializeReadyCustomerTruthDeltas,
  processIntelligenceQueue,
} from "@applywizz/domain/meeting-intelligence";
import { OpenRouterMeetingIntelligenceProvider } from "@applywizz/ai";
import { validateState } from "@applywizz/microsoft";
import {
  getInternalQueueSecret,
  getOpenRouterEnv,
  getSupabaseServiceRoleKey,
} from "@/env/server";
import { getClientEnv } from "@/env/client";

/**
 * Same secret-header gate and three-phase shape as
 * /api/internal/transcription/process (M8): per-org enqueue, ONE global
 * queue drain (claim_next_meeting_intelligence_run has no organization_id
 * parameter — same reasoning as claim_next_transcription_job), then a
 * per-org materialize sweep (M9 correction #1's deferred-linkage catch-up
 * — cheap and safe to run every tick, no-ops for everything already
 * materialized or still unlinked). Never runs synchronously in a
 * user-facing request — this is the only place
 * OpenRouterMeetingIntelligenceProvider gets constructed with a real key.
 */
export async function POST(request: NextRequest) {
  const provided = request.headers.get("x-internal-queue-secret");
  if (!validateState(provided, getInternalQueueSecret())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const openRouterEnv = getOpenRouterEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  const deps = {
    provider: new OpenRouterMeetingIntelligenceProvider(
      openRouterEnv.OPENROUTER_API_KEY,
    ),
  };

  const { data: organizations, error } = await serviceRoleClient
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const enqueueResults = [];
  for (const org of organizations ?? []) {
    try {
      const enqueueResult = await enqueuePendingIntelligenceRuns(
        serviceRoleClient,
        org.id,
      );
      enqueueResults.push({ organizationId: org.id, ...enqueueResult });
    } catch (enqueueError) {
      enqueueResults.push({
        organizationId: org.id,
        error:
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError),
      });
    }
  }

  let queueResult;
  try {
    queueResult = await processIntelligenceQueue(serviceRoleClient, deps, 5);
  } catch (queueError) {
    return NextResponse.json(
      {
        enqueueResults,
        queueError:
          queueError instanceof Error ? queueError.message : String(queueError),
      },
      { status: 500 },
    );
  }

  const materializeResults = [];
  for (const org of organizations ?? []) {
    try {
      const materializeResult = await materializeReadyCustomerTruthDeltas(
        serviceRoleClient,
        org.id,
      );
      materializeResults.push({ organizationId: org.id, ...materializeResult });
    } catch (materializeError) {
      materializeResults.push({
        organizationId: org.id,
        error:
          materializeError instanceof Error
            ? materializeError.message
            : String(materializeError),
      });
    }
  }

  return NextResponse.json(
    { enqueueResults, queueResult, materializeResults },
    { status: 200 },
  );
}
