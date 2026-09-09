import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  recoverStuckJobs,
  syncIncidentsWithCurrentState,
} from "@applywizz/domain/operations-recovery";
import {
  VexaMeetingBotProvider,
  type MeetingBotProvider,
} from "@applywizz/meeting-bots";
import {
  getSupabaseServiceRoleKey,
  getVexaEnv,
  toVexaEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * M16 Slice A/B: recovers stuck jobs and keeps incidents in sync with
 * current queue state, per org. Same auth gate as every other
 * /api/internal route. M17B: scheduled per docs/product/m17-plan.md §6.
 * Constructs the real VexaMeetingBotProvider here (same pattern as
 * /api/internal/meeting-bots/tick) — the domain layer only ever sees the
 * provider-agnostic MeetingBotProvider interface, used to verify a stuck
 * bot job is actually gone before recovering it.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  // Unlike /api/internal/meeting-bots/tick (entirely bot-focused, so it's
  // correct for that route to 501 outright when Vexa isn't configured),
  // this route also recovers 3 Vexa-independent queues. Vexa being
  // unconfigured must not block calendar/transcription/meeting-intelligence
  // recovery — it should only make meeting-bot recovery fall back to its
  // own fail-safe path (provider check always "fails" → defer, never
  // requeue blind).
  let provider: MeetingBotProvider;
  try {
    provider = new VexaMeetingBotProvider(toVexaEnv(getVexaEnv()));
  } catch {
    provider = {
      name: "unavailable",
      createBot() {
        return Promise.reject(new Error("Vexa is not configured."));
      },
      cancelBot() {
        return Promise.reject(new Error("Vexa is not configured."));
      },
      getBotStatus() {
        return Promise.reject(new Error("Vexa is not configured."));
      },
    };
  }

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
      const recovery = await recoverStuckJobs(
        serviceRoleClient,
        provider,
        org.id,
      );
      await syncIncidentsWithCurrentState(serviceRoleClient, org.id);
      results.push({ organizationId: org.id, recovery });
    } catch (orgError) {
      results.push({
        organizationId: org.id,
        error: orgError instanceof Error ? orgError.message : String(orgError),
      });
    }
  }

  return NextResponse.json({ results }, { status: 200 });
}

export const GET = POST;
