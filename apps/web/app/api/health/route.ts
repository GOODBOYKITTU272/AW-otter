import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";

/**
 * M17B: the hosting platform's own liveness probe target — deliberately
 * public (no internal-route secret), matching how uptime monitors and
 * platform health checks are conventionally wired; a health check that
 * requires a credential defeats its own purpose. Reveals nothing beyond
 * "the app process is up and can reach the database" — no stack traces,
 * no internal detail, on either path.
 */
export async function GET() {
  try {
    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );
    const { error } = await serviceRoleClient
      .from("organizations")
      .select("id")
      .limit(1);
    if (error) {
      return NextResponse.json({ status: "degraded" }, { status: 503 });
    }
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
