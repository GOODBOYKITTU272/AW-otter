import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  enqueuePendingTranscriptions,
  processTranscriptionQueue,
} from "@applywizz/domain/transcription";
import {
  OpenRouterNormalizationProvider,
  OpenRouterTranscriptionProvider,
} from "@applywizz/transcription";
import { validateState } from "@applywizz/microsoft";
import {
  getInternalQueueSecret,
  getOpenRouterEnv,
  getSupabaseServiceRoleKey,
  getVexaEnv,
  toVexaEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";

/**
 * Same secret-header gate as every other /api/internal route. Two
 * distinct phases: (1) per-org enqueue of any newly-completed bot
 * sessions (enqueuePendingTranscriptions takes an organizationId — it
 * genuinely needs the loop), then (2) ONE global queue drain.
 *
 * Codex post-implementation review (SHOULD-FIX): claim_next_transcription_job
 * has no organization_id parameter at all — it's a system-wide FOR UPDATE
 * SKIP LOCKED claim, same shape as claim_next_calendar_event_job (M4),
 * which processCalendarEventQueue also calls exactly once, not per-org.
 * Nesting processTranscriptionQueue inside the org loop was a real bug:
 * a claim made "for" org A's loop iteration could actually belong to org
 * B, misattributing results and offering no real per-org scoping anyway.
 * Never runs synchronously in a user-facing request — this is the only
 * place OpenRouterTranscriptionProvider/OpenRouterNormalizationProvider
 * get constructed with a real key.
 */
export async function POST(request: NextRequest) {
  const provided = request.headers.get("x-internal-queue-secret");
  if (!validateState(provided, getInternalQueueSecret())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const openRouterEnv = getOpenRouterEnv();
  const vexaEnv = toVexaEnv(getVexaEnv());
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  const deps = {
    vexaEnv,
    transcriptionProvider: new OpenRouterTranscriptionProvider(
      openRouterEnv.OPENROUTER_API_KEY,
    ),
    normalizationProvider: new OpenRouterNormalizationProvider(
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
      const enqueueResult = await enqueuePendingTranscriptions(
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
    queueResult = await processTranscriptionQueue(serviceRoleClient, deps, 5);
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

  return NextResponse.json({ enqueueResults, queueResult }, { status: 200 });
}
