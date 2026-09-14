import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  enqueuePendingOutcomeGeneration,
  processOutcomeQueue,
} from "@applywizz/domain/meeting-outcome-generation";
import { OpenRouterMeetingOutcomeProvider } from "@applywizz/ai";
import { getOpenRouterEnv, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * Background worker endpoint for generating meeting outcomes (Fathom-style Overview extraction).
 * Follows the same pattern as meeting-intelligence/process: per-org enqueue, global queue drain.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const openRouterEnv = getOpenRouterEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  const deps = {
    provider: new OpenRouterMeetingOutcomeProvider(
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
      const enqueueResult = await enqueuePendingOutcomeGeneration(
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
    queueResult = await processOutcomeQueue(serviceRoleClient, deps, 5);
  } catch (queueError) {
    const message =
      queueError instanceof Error ? queueError.message : String(queueError);
    // Table not migrated yet — cron should not page as a 500.
    if (/meeting_outcomes|42P01|PGRST205/i.test(message)) {
      return NextResponse.json(
        { enqueueResults, skipped: true, reason: "meeting_outcomes table not migrated" },
        { status: 200 },
      );
    }
    return NextResponse.json(
      { enqueueResults, queueError: message },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { enqueueResults, queueResult },
    { status: 200 },
  );
}

export const GET = POST;
