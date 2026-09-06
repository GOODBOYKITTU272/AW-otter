import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { processCalendarEventQueue } from "@applywizz/domain/meetings";
import { validateState } from "@applywizz/microsoft";
import {
  getEncryptionKey,
  getInternalQueueSecret,
  getMicrosoftEnv,
  getSupabaseServiceRoleKey,
  toMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";

// Not reachable by any authenticated app user — a shared secret header, not
// a Supabase session, gates this route (see getInternalQueueSecret). No
// scheduler exists yet in M4 (that's worker infra, out of scope); this is
// called on demand for now, the same way M3's subscription renewal is.
export async function POST(request: NextRequest) {
  const provided = request.headers.get("x-internal-queue-secret");
  if (!validateState(provided, getInternalQueueSecret())) {
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
