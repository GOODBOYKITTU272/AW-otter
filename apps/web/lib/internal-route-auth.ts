import type { NextRequest } from "next/server";
import { validateState } from "@applywizz/microsoft";
import { getCronSecret, getInternalQueueSecret } from "@/env/server";

/**
 * M17B: every /api/internal/* route needs to be reachable two ways —
 * manually/on-demand via the existing `x-internal-queue-secret` header
 * (unchanged, everything already tested against this all session), and
 * now also by a scheduled GET request from a cron trigger that can only
 * send `Authorization: Bearer <token>` (Vercel Cron Jobs' native shape,
 * shared by most equivalent schedulers). Both checks are constant-time
 * (validateState, matching every other secret compare in this codebase).
 *
 * The cron path is safe to attempt even where CRON_SECRET was never
 * configured (local dev, CI, a scheduler that just reuses
 * INTERNAL_QUEUE_SECRET directly) — it fails closed, not open, if the env
 * var is unset.
 */
export function isAuthorizedInternalRequest(request: NextRequest): boolean {
  const provided = request.headers.get("x-internal-queue-secret");
  if (validateState(provided, getInternalQueueSecret())) return true;

  const authHeader = request.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : null;
  if (!bearer) return false;

  let cronSecret: string;
  try {
    cronSecret = getCronSecret();
  } catch {
    return false;
  }
  return validateState(bearer, cronSecret);
}
