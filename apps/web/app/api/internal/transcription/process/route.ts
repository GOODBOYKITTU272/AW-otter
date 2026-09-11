import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  enqueuePendingTranscriptions,
  processTranscriptionQueue,
} from "@applywizz/domain/transcription";
import {
  MEETING_RECORDINGS_BUCKET,
  type RecordingStorageClient,
} from "@applywizz/domain/meeting-recordings";
import {
  OpenRouterNormalizationProvider,
  OpenRouterTranscriptionProvider,
  createTranscriptionProvider,
} from "@applywizz/transcription";
import {
  getAzureMaiEnv,
  getOpenRouterEnv,
  getSupabaseServiceRoleKey,
  getTranscriptionConfigEnv,
  getVexaEnv,
  toVexaEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * Same auth gate as every other /api/internal route. Two distinct phases:
 * (1) per-org enqueue of any newly-completed bot sessions
 * (enqueuePendingTranscriptions takes an organizationId — it genuinely
 * needs the loop), then (2) ONE global queue drain.
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
 *
 * M17B: deliberately NOT wired to GET/cron here, unlike the other
 * /api/internal routes — this route's own transcodeToOpusOgg step shells
 * out to the system ffmpeg/ffprobe binaries (packages/domain/src/
 * audio-transcode.ts), which a bare serverless function doesn't provide
 * (see docs/ops/production-environment.md §11). The scheduled trigger for
 * this queue is workers/transcription-worker/ instead, which calls the
 * exact same enqueuePendingTranscriptions/processTranscriptionQueue
 * domain functions directly, on a host where ffmpeg is actually
 * installed. This route stays POST-only for manual/on-demand invocation.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const openRouterEnv = getOpenRouterEnv();
  const vexaEnv = toVexaEnv(getVexaEnv());
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  // The real Supabase Storage client's info() types `size` as possibly
  // undefined (some FileObjectV2 shapes omit it) even though
  // RecordingStorageClient (Task 6, unchanged here) expects a definite
  // number. Rather than widen that contract, normalize at this one
  // real-SDK boundary: a missing size becomes an impossible sentinel (-1)
  // that can never equal a real Vexa-reported file size, so
  // ensureOwnedRecording's existing mismatch check still fails closed
  // exactly as designed — it just never trusts an ambiguous "no size
  // reported" as if it were a verified size.
  const recordingsBucket = serviceRoleClient.storage.from(
    MEETING_RECORDINGS_BUCKET,
  );
  const storage: RecordingStorageClient = {
    upload: (path, body, opts) => recordingsBucket.upload(path, body, opts),
    download: (path) => recordingsBucket.download(path),
    info: async (path) => {
      const { data, error } = await recordingsBucket.info(path);
      if (error || !data) return { data: null, error };
      return {
        data: { size: data.size ?? -1, contentType: data.contentType },
        error: null,
      };
    },
  };

  const azureMaiEnv = getAzureMaiEnv();
  const transcriptionConfig = getTranscriptionConfigEnv();

  const transcriptionProvider = createTranscriptionProvider({
    primaryProvider: transcriptionConfig.TRANSCRIPTION_PRIMARY_PROVIDER,
    azureMai: azureMaiEnv.isConfigured
      ? {
          endpoint: azureMaiEnv.AZURE_MAI_ENDPOINT,
          apiKey: azureMaiEnv.AZURE_MAI_KEY,
          region: azureMaiEnv.AZURE_MAI_REGION,
        }
      : undefined,
    openRouter: {
      apiKey: openRouterEnv.OPENROUTER_API_KEY,
    },
  });

  const fallbackProvider =
    transcriptionConfig.TRANSCRIPTION_PRIMARY_PROVIDER === "azure-mai"
      ? new OpenRouterTranscriptionProvider(openRouterEnv.OPENROUTER_API_KEY)
      : undefined;

  const deps = {
    vexaEnv,
    transcriptionProvider,
    fallbackProvider,
    normalizationProvider: new OpenRouterNormalizationProvider(
      openRouterEnv.OPENROUTER_API_KEY,
    ),
    storage,
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
