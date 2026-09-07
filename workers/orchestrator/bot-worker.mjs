// M6's durable job/worker process — runs OUTSIDE the browser/request
// cycle, satisfying the architecture rule "use durable job/worker flow,
// do not rely on browser execution." Polls the same domain functions the
// /api/internal/meeting-bots/tick route calls on demand, on a fixed
// interval, until the process is killed.
//
// Run with:
//   node --env-file=apps/web/.env.local workers/orchestrator/bot-worker.mjs
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

async function loop() {
  while (true) {
    try {
      await tick();
    } catch (tickError) {
      console.error("[bot-worker] tick failed:", tickError);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_INTERVAL_MS));
  }
}

loop();
