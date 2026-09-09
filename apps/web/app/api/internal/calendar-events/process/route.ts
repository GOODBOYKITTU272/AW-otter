import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { processCalendarEventQueue } from "@applywizz/domain/meetings";
import {
  getEncryptionKey,
  getMicrosoftEnv,
  getSupabaseServiceRoleKey,
  toMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

// Not reachable by any authenticated app user — gated by
// isAuthorizedInternalRequest (a shared secret header or a scheduler's
// Bearer token), never a Supabase session. M17B: scheduled per
// docs/product/m17-plan.md §6 (GET, invoked by the platform scheduler);
// POST remains for manual/on-demand invocation, unchanged.
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  const result = await processCalendarEventQueue(serviceRoleClient, {
    microsoftEnv: toMicrosoftEnv(getMicrosoftEnv()),
    encryptionKey: getEncryptionKey(),
  });

  return NextResponse.json(result, { status: 200 });
}

export const GET = POST;
