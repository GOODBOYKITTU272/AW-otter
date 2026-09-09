import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { GraphApiError } from "@applywizz/microsoft";
import { renewMicrosoftSubscription, type MicrosoftEnv } from "./microsoft-connection";
import { recordIncident } from "./operational-incidents";

export type AppSupabaseClient = SupabaseClient<Database>;

// Graph's own cap for calendar-resource subscriptions is 4230 minutes
// (~70.5h — see packages/microsoft/src/config.ts's MAX_SUBSCRIPTION_MINUTES,
// "not a number ApplyWizz chose"). Renewing daily, this window means a
// subscription enters "due for renewal" with ~46.5h of life left — enough
// margin for at least two daily attempts before the hard Graph cutoff, even
// if one tick fails outright (a transient Graph error, a token refresh
// hiccup). M17A's plan recommended daily; this constant is what makes that
// recommendation concrete.
const RENEWAL_WINDOW_HOURS = 24;

export interface RenewalOutcome {
  renewed: number;
  failed: number;
}

/**
 * M17B: the scheduling this repo has been missing since M3 —
 * renewMicrosoftSubscription already existed and worked, nothing ever
 * called it on a cadence (M17A finding, confirmed by grep: zero callers
 * anywhere outside its own definition before this file).
 *
 * Idempotent and concurrency-safe the same way M16's recoverStuckJobs is:
 * a CAS claim (status must still match what THIS call observed) before
 * attempting a renewal, so two overlapping sweeps — or a slow renewal
 * still in flight when the next scheduled tick fires — can never both
 * renew the same subscription or leave two renewal attempts racing
 * against the same external_subscription_id. A failed renewal reverts
 * the claim so the next tick retries; a subscription Graph has already
 * dropped entirely (404 — happens if renewal has been failing long enough
 * to cross the ~70.5h ceiling) is NOT silently retried forever: it's
 * flagged critical, since retrying a renewal for a subscription Graph no
 * longer has can never succeed — that needs a human (or M17C's real
 * end-to-end pass) to re-establish the subscription, deliberately not
 * auto-recreated here (creating a brand-new subscription against a real
 * tenant is exactly the kind of real-Microsoft action this checkpoint is
 * scoped to NOT perform yet).
 */
export async function renewExpiringMicrosoftSubscriptions(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  microsoftEnv: MicrosoftEnv,
  encryptionKey: string,
  fetchImpl?: typeof fetch,
): Promise<RenewalOutcome> {
  const { data: memberships, error: membershipsError } = await supabase
    .from("organization_memberships")
    .select("id")
    .eq("organization_id", organizationId);
  if (membershipsError) throw membershipsError;
  const membershipIds = (memberships ?? []).map((m) => m.id);
  if (membershipIds.length === 0) return { renewed: 0, failed: 0 };

  const { data: connections, error: connectionsError } = await supabase
    .from("calendar_connections")
    .select("id")
    .in("organization_membership_id", membershipIds)
    // M17B review fix: a disconnected connection's subscription rows must
    // never be swept. Without this, a subscription left over from a
    // disconnect-vs-renewal race (see the CAS fix below) would be
    // retried forever against a connection that no longer has valid
    // credentials, generating a permanent, never-resolving incident.
    .eq("status", "active");
  if (connectionsError) throw connectionsError;
  const connectionIds = (connections ?? []).map((c) => c.id);
  if (connectionIds.length === 0) return { renewed: 0, failed: 0 };

  const renewBefore = new Date(
    Date.now() + RENEWAL_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: subscriptions, error: subscriptionsError } = await supabase
    .from("provider_subscriptions")
    .select("id, status, expires_at")
    .in("calendar_connection_id", connectionIds)
    .eq("status", "active")
    .lt("expires_at", renewBefore);
  if (subscriptionsError) throw subscriptionsError;

  let renewed = 0;
  let failed = 0;

  for (const subscription of subscriptions ?? []) {
    const { data: claimed, error: claimError } = await serviceRoleClient
      .from("provider_subscriptions")
      .update({ status: "renewing" })
      .eq("id", subscription.id)
      .eq("status", subscription.status)
      .eq("expires_at", subscription.expires_at)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue; // lost the race — another sweep already has it

    try {
      await renewMicrosoftSubscription(
        supabase,
        serviceRoleClient,
        subscription.id,
        microsoftEnv,
        encryptionKey,
        fetchImpl,
      );
      renewed++;
    } catch (renewError) {
      failed++;
      // Revert the claim so the next tick retries — a failed renewal must
      // never leave a subscription permanently stuck in "renewing". CAS
      // guarded (M17B review fix): only revert if the row is still
      // exactly the "renewing" state THIS call put it in — if something
      // else changed it in the meantime (e.g. disconnectMicrosoftConnection
      // racing this same row), that other write must win, not get
      // silently overwritten back to "active".
      await serviceRoleClient
        .from("provider_subscriptions")
        .update({ status: "active" })
        .eq("id", subscription.id)
        .eq("status", "renewing");

      const gone =
        renewError instanceof GraphApiError && renewError.status === 404;
      await recordIncident(serviceRoleClient, {
        organizationId,
        queue: "microsoft_subscription",
        entityId: subscription.id,
        incidentType: "renewal_failed",
        severity: gone ? "critical" : "warning",
        reason: gone
          ? "microsoft_subscription_renewal: subscription no longer exists on Graph, cannot be renewed"
          : "microsoft_subscription_renewal: renewal attempt failed, will retry",
      });
    }
  }

  return { renewed, failed };
}
