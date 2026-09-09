import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { reconcileOrganizationSchedulerCalls } from "@applywizz/domain/scheduler-linkage";
import { reconcileOrganizationCustomerLinkage } from "@applywizz/domain/customer-linkage";
import {
  getSchedulerEnv,
  getSupabaseServiceRoleKey,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * Same auth gate as every other /api/internal route. Runs the FULL M7A
 * linkage pipeline for every active organization, in the order the
 * revised plan requires: scheduler-driven Tiers 1-3 (highest confidence —
 * real lead_id/AM/Teams identity) first, then the existing, UNCHANGED
 * attendee-email Tier 4 fallback — whose own RESOLVED_STATUSES check
 * already skips anything the scheduler tier just linked, so running them
 * in this order is what gives the right tier priority; no shared code
 * path between the two was needed. M17B: scheduled per
 * docs/product/m17-plan.md §6.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientEnv = getClientEnv();
  const schedulerEnv = getSchedulerEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

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
      const schedulerResult = await reconcileOrganizationSchedulerCalls(
        serviceRoleClient,
        org.id,
        schedulerEnv.APPLYWIZZ_SCHEDULER_BASE_URL,
      );
      const fallbackResult = await reconcileOrganizationCustomerLinkage(
        serviceRoleClient,
        org.id,
      );
      results.push({
        organizationId: org.id,
        scheduler: schedulerResult,
        attendeeFallback: fallbackResult,
      });
    } catch (reconcileError) {
      results.push({
        organizationId: org.id,
        error:
          reconcileError instanceof Error
            ? reconcileError.message
            : String(reconcileError),
      });
    }
  }

  return NextResponse.json(
    { organizationsProcessed: results.length, results },
    { status: 200 },
  );
}

export const GET = POST;
