// M17B's transcription worker — the durable process transcription needs
// because it's the one queue that can't safely run as a scheduled
// serverless function: packages/domain/src/audio-transcode.ts shells out
// to the system ffmpeg/ffprobe binaries unconditionally for every job
// (transcription.ts:216), which a bare Vercel function doesn't provide
// (see docs/ops/production-environment.md §11 for the full analysis).
// This Dockerfile installs ffmpeg the same way CI already proves works
// (apt-get install ffmpeg); everything else in this file just calls the
// exact same domain functions /api/internal/transcription/process/route.ts
// already calls — no duplicated business logic, no redesign.
//
// Mirrors workers/orchestrator/bot-worker.mjs's shape exactly: a
// stateless tick loop, no in-memory state carried between ticks (every
// tick reads fresh from Supabase and the provider), restart-safe (a
// thrown error inside one tick is caught and logged, the loop continues;
// the outer container's own restart policy handles a fully-crashed
// process). A heartbeat file backs the Docker HEALTHCHECK below — a
// successful tick (whether or not it found any work) touches it, so a
// stuck/hung worker (no successful tick in 3x the tick interval) reports
// unhealthy and can be restarted by the container orchestrator, without
// needing a new DB table or schema change for this.
//
// Run with:
//   npx tsx --env-file=apps/web/.env.local workers/transcription-worker/transcription-worker.mjs
//
// Must run via tsx, not plain `node` — confirmed by actually trying:
// plain node cannot resolve this file's transitive workspace imports
// (@applywizz/domain/transcription -> its own extensionless relative
// import of "./audio-transcode") and throws ERR_MODULE_NOT_FOUND
// immediately. The exact same issue was found (and fixed the same way)
// in workers/orchestrator/bot-worker.mjs during this same M17B pass —
// that one had never actually been run this way successfully either.
//
// Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// OPENROUTER_API_KEY, VEXA_BASE_URL, VEXA_API_KEY (same env vars the app
// itself uses for these — transcription jobs originate from completed
// bot sessions, so it needs Vexa's recording handoff too, not just
// OpenRouter).

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import {
  enqueuePendingTranscriptions,
  processTranscriptionQueue,
} from "@applywizz/domain/transcription";
import { MEETING_RECORDINGS_BUCKET } from "@applywizz/domain/meeting-recordings";
import {
  OpenRouterNormalizationProvider,
  OpenRouterTranscriptionProvider,
  SarvamTranscriptionProvider,
  createTranscriptionProvider,
} from "@applywizz/transcription";
import { shouldUseLanguageRouting } from "@applywizz/domain/language-routing";

const TICK_INTERVAL_MS = Number(
  process.env.TRANSCRIPTION_WORKER_TICK_INTERVAL_MS ?? 60_000,
);
const HEARTBEAT_PATH = process.env.HEARTBEAT_PATH ?? "/tmp/transcription-worker-heartbeat";
const QUEUE_BATCH_SIZE = 5; // matches /api/internal/transcription/process's own batch size

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

const openRouterApiKey = requiredEnv("OPENROUTER_API_KEY");
const primaryProviderName = process.env.TRANSCRIPTION_PRIMARY_PROVIDER || "openrouter";
const azureEndpoint = process.env.AZURE_MAI_ENDPOINT;
const azureKey = process.env.AZURE_MAI_KEY;
const azureRegion = process.env.AZURE_MAI_REGION;
const sarvamApiKey = process.env.SARVAM_API_KEY;
const enableLanguageRouting = process.env.ENABLE_LANGUAGE_ROUTING !== "false";

// Create individual provider instances for language-based routing
const whisperProvider = new OpenRouterTranscriptionProvider(openRouterApiKey);
const sarvamProvider = sarvamApiKey ? new SarvamTranscriptionProvider(sarvamApiKey) : undefined;

const transcriptionProvider = createTranscriptionProvider({
  primaryProvider: primaryProviderName,
  azureMai: (azureEndpoint && azureKey)
    ? {
        endpoint: azureEndpoint,
        apiKey: azureKey,
        region: azureRegion,
      }
    : undefined,
  sarvam: sarvamApiKey ? { apiKey: sarvamApiKey } : undefined,
  openRouter: {
    apiKey: openRouterApiKey,
  },
});

// Language-based routing (new default) OR legacy provider chain (backward compat)
let providers = undefined;
let fallbackProvider = undefined;
let useLanguageRouting = false;

if (shouldUseLanguageRouting(primaryProviderName, enableLanguageRouting)) {
  // New: Language-based routing enabled
  // Providers will be selected at runtime based on detected language
  useLanguageRouting = true;
} else if (primaryProviderName === "azure-mai") {
  // Legacy: Three-provider fallback chain for azure-mai primary (Azure → Sarvam → Whisper)
  if (sarvamProvider) {
    providers = [transcriptionProvider, sarvamProvider, whisperProvider];
  } else {
    providers = [transcriptionProvider, whisperProvider];
  }
} else {
  // Legacy: Single provider, no fallback
  fallbackProvider = undefined;
}

const deps = {
  vexaEnv: {
    baseUrl: requiredEnv("VEXA_BASE_URL"),
    apiKey: requiredEnv("VEXA_API_KEY"),
  },
  transcriptionProvider,
  fallbackProvider,
  providers,
  useLanguageRouting,
  whisperProvider,
  sarvamProvider,
  azureProvider: (azureEndpoint && azureKey) ? transcriptionProvider : undefined,
  normalizationProvider: new OpenRouterNormalizationProvider(openRouterApiKey),
  storage: supabase.storage.from(MEETING_RECORDINGS_BUCKET),
};

function touchHeartbeat() {
  try {
    writeFileSync(HEARTBEAT_PATH, new Date().toISOString());
  } catch (heartbeatError) {
    // Never let a heartbeat write failure take down the worker itself —
    // worst case the container's healthcheck starts failing, which is
    // exactly the visible-failure behavior we want anyway.
    console.error("[transcription-worker] heartbeat write failed:", heartbeatError);
  }
}

async function tick() {
  const { data: organizations, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (error) throw error;

  const enqueueResults = [];
  for (const org of organizations ?? []) {
    try {
      const result = await enqueuePendingTranscriptions(supabase, org.id);
      enqueueResults.push({ organizationId: org.id, ...result });
    } catch (enqueueError) {
      console.error(
        `[transcription-worker] enqueue failed for org ${org.id}:`,
        enqueueError,
      );
    }
  }

  const queueResult = await processTranscriptionQueue(
    supabase,
    deps,
    QUEUE_BATCH_SIZE,
  );

  if (
    enqueueResults.some((r) => (r.enqueued ?? 0) > 0) ||
    queueResult.completed > 0 ||
    queueResult.failed > 0
  ) {
    console.log("[transcription-worker] tick:", {
      enqueueResults,
      queueResult,
      organizations: organizations?.length ?? 0,
    });
  }

  touchHeartbeat();
}

console.log(
  `[transcription-worker] starting, tick every ${TICK_INTERVAL_MS}ms, batch size ${QUEUE_BATCH_SIZE}`,
);
// No initial touchHeartbeat() here on purpose — the container's own
// HEALTHCHECK --start-period covers the startup grace window (Dockerfile),
// so the heartbeat file only ever reflects a GENUINELY successful tick,
// never a manufactured "healthy" before anything has actually worked.

// Graceful shutdown: never aborts an in-progress tick (a running claim
// keeps running exactly as before — same idempotency/claim guarantees,
// zero change to orchestration semantics), it only stops SCHEDULING the
// next tick and, if currently sleeping between ticks, wakes up
// immediately instead of waiting out the rest of the interval. Without
// this, an orchestrator's SIGTERM grace period (commonly ~10s) can
// expire before a 60s sleep would have noticed anything, forcing a
// SIGKILL regardless of how "graceful" the intent was.
let shuttingDown = false;
let currentSleepResolve = null;

function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    currentSleepResolve = resolve;
    setTimeout(() => {
      currentSleepResolve = null;
      resolve();
    }, ms);
  });
}

function requestShutdown(signal) {
  console.log(
    `[transcription-worker] received ${signal}, shutting down after the current tick (if any) completes...`,
  );
  shuttingDown = true;
  if (currentSleepResolve) {
    const resolve = currentSleepResolve;
    currentSleepResolve = null;
    resolve();
  }
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

async function loop() {
  while (!shuttingDown) {
    try {
      await tick();
    } catch (tickError) {
      console.error("[transcription-worker] tick failed:", tickError);
    }
    if (shuttingDown) break;
    await interruptibleSleep(TICK_INTERVAL_MS);
  }
  console.log("[transcription-worker] shut down cleanly");
  process.exit(0);
}

loop();
