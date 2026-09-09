// M6's durable job/worker process — runs OUTSIDE the browser/request
// cycle, satisfying the architecture rule "use durable job/worker flow,
// do not rely on browser execution." Polls the same domain functions the
// /api/internal/meeting-bots/tick route calls on demand, on a fixed
// interval, until the process is killed.
//
// Run with:
//   npx tsx --env-file=apps/web/.env.local workers/orchestrator/bot-worker.mjs
//
// M17B fix: plain `node` cannot resolve this file's transitive workspace
// imports (@applywizz/domain -> meeting-bots.ts -> its own extensionless
// relative imports like "./types") — Node's ESM loader does not add a
// .ts extension the way a bundler/TS-aware runner does, so `node
// bot-worker.mjs` has always thrown ERR_MODULE_NOT_FOUND immediately,
// confirmed by actually running it. tsx (already a repo devDependency)
// resolves this correctly — verified the same way.
//
// Requires: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// VEXA_BASE_URL, VEXA_API_KEY (same env vars the app itself uses).

import { createClient } from "@supabase/supabase-js";
import {
  reconcileOrganizationMeetingBots,
  processPendingBotJobs,
  syncBotStatuses,
} from "@applywizz/domain/meeting-bots";
import { VexaMeetingBotProvider } from "@applywizz/meeting-bots";

const TICK_INTERVAL_MS = Number(
  process.env.BOT_WORKER_TICK_INTERVAL_MS ?? 30_000,
);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const supabase = createClient(
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
  requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
);

const provider = new VexaMeetingBotProvider({
  baseUrl: requiredEnv("VEXA_BASE_URL"),
  apiKey: requiredEnv("VEXA_API_KEY"),
});

async function tick() {
  const { data: organizations, error } = await supabase
    .from("organizations")
    .select("id")
    .eq("status", "active");
  if (error) throw error;

  for (const org of organizations ?? []) {
    try {
      await reconcileOrganizationMeetingBots(supabase, provider, org.id);
    } catch (reconcileError) {
      console.error(
        `[bot-worker] reconcile failed for org ${org.id}:`,
        reconcileError,
      );
    }
  }

  const processResult = await processPendingBotJobs(supabase, provider);
  const statusResult = await syncBotStatuses(supabase, provider);

  if (
    processResult.scheduled > 0 ||
    processResult.failed > 0 ||
    statusResult.updated > 0
  ) {
    console.log("[bot-worker] tick:", {
      processResult,
      statusResult,
      organizations: organizations?.length ?? 0,
    });
  }
}

console.log(`[bot-worker] starting, tick every ${TICK_INTERVAL_MS}ms`);

// M17B: graceful shutdown, same small pattern added to
// workers/transcription-worker/transcription-worker.mjs — never aborts an
// in-progress tick (identical orchestration semantics/timing to before),
// only stops scheduling the next tick and wakes an in-progress sleep
// immediately instead of waiting out the rest of the interval.
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
    `[bot-worker] received ${signal}, shutting down after the current tick (if any) completes...`,
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
      console.error("[bot-worker] tick failed:", tickError);
    }
    if (shuttingDown) break;
    await interruptibleSleep(TICK_INTERVAL_MS);
  }
  console.log("[bot-worker] shut down cleanly");
  process.exit(0);
}

loop();
