import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { renewExpiringMicrosoftSubscriptions } from "@applywizz/domain/microsoft-subscription-renewal";
import {
  getEncryptionKey,
  getMicrosoftEnv,
  getSupabaseServiceRoleKey,
  toMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * M17B: the scheduled caller renewMicrosoftSubscription has needed since
 * M3 (M17A finding — coded, never wired). Same auth gate and per-org loop
 * shape as every other /api/internal route. Intended cadence: daily, per
 * docs/product/m17-plan.md §6.
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
  const microsoftEnv = toMicrosoftEnv(getMicrosoftEnv());
  const encryptionKey = getEncryptionKey();

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
      const outcome = await renewExpiringMicrosoftSubscriptions(
        serviceRoleClient,
        serviceRoleClient,
        org.id,
        microsoftEnv,
        encryptionKey,
      );
      results.push({ organizationId: org.id, ...outcome });
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
