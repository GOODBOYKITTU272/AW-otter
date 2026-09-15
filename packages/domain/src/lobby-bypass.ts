import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { patchOnlineMeetingLobbyBypass } from "@applywizz/microsoft";
import { getFeatureFlags } from "./feature-flags";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Track B′: Apply lobby bypass for Apply Wizz–organized meetings.
 * 
 * When a meeting has an online_meeting_id, PATCH the Graph online meeting
 * to set lobbyBypassSettings.scope="everyone" so anonymous guest bots
 * (Vexa) are less likely to wait in lobby.
 * 
 * Defense-in-depth hypothesis: meeting-level bypass helps even when
 * tenant-level policy (Track A) is already applied.
 * 
 * Idempotent and best-effort:
 * - Logs success/failure but never throws
 * - Bot join proceeds regardless of PATCH outcome
 * - Requires OnlineMeetings.ReadWrite.All permission
 * 
 * @param serviceRoleClient - Supabase service role client
 * @param graphAccessToken - App-only Graph token with OnlineMeetings.ReadWrite.All
 * @param meetingId - Meeting UUID
 * @param onlineMeetingId - Graph online meeting ID (from meeting.online_meeting_id)
 * @param organizerEmail - Organizer email (to resolve to Azure AD GUID)
 * @param organizationId - Organization UUID (for audit logging)
 */
export async function applyLobbyBypassIfEnabled(
  serviceRoleClient: AppSupabaseClient,
  graphAccessToken: string,
  meetingId: string,
  onlineMeetingId: string,
  organizerEmail: string,
  organizationId: string,
): Promise<void> {
  const flags = getFeatureFlags();
  if (!flags.enableLobbyBypassPatch) {
    return; // Feature disabled, silent no-op
  }

  try {
    // Resolve organizer email to Azure AD GUID (same as Path C recording ingest)
    const userOid = await resolveOrganizerToGuid(serviceRoleClient, organizerEmail);
    if (!userOid) {
      await logAuditEvent(serviceRoleClient, {
        organizationId,
        actorId: null,
        action: "meeting.lobby_bypass_skipped_no_guid",
        entityType: "meeting",
        entityId: meetingId,
        metadata: { 
          reason: "Cannot resolve organizer to Azure AD GUID",
          organizerEmail,
        },
      });
      return;
    }

    // PATCH the online meeting
    await patchOnlineMeetingLobbyBypass(
      graphAccessToken,
      userOid,
      onlineMeetingId,
    );

    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "meeting.lobby_bypass_applied",
      entityType: "meeting",
      entityId: meetingId,
      metadata: { onlineMeetingId, userOid },
    });
  } catch (error) {
    // Best-effort: log failure but don't propagate error
    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "meeting.lobby_bypass_failed",
      entityType: "meeting",
      entityId: meetingId,
      metadata: {
        error: error instanceof Error ? error.message : String(error),
        onlineMeetingId,
      },
    });
  }
}

/**
 * Resolve organizer email to Azure AD object ID (GUID).
 * 
 * Graph's /users/{userOid}/onlineMeetings/... path requires an Azure AD
 * object ID, not UPN/email. This looks up provider_user_id from
 * calendar_connections by matching the organizer email in scope_metadata.
 * 
 * Same implementation as Path C (apps/web/app/api/internal/video-recordings/ingest/route.ts).
 * 
 * @param serviceRoleClient - Supabase service role client
 * @param organizerEmail - Organizer email from meeting record (case-insensitive)
 * @returns Azure AD object ID (GUID) if found, null otherwise
 */
async function resolveOrganizerToGuid(
  serviceRoleClient: AppSupabaseClient,
  organizerEmail: string,
): Promise<string | null> {
  const { data } = await serviceRoleClient
    .from("calendar_connections")
    .select("provider_user_id, scope_metadata")
    .eq("provider", "microsoft")
    .eq("status", "active");

  if (!data) return null;

  // Filter in-memory for case-insensitive email match (JSONB email comparison)
  const normalizedEmail = organizerEmail.toLowerCase();
  const match = data.find((conn) => {
    const metadata = conn.scope_metadata as { email?: string } | null;
    return metadata?.email?.toLowerCase() === normalizedEmail;
  });

  return match?.provider_user_id ?? null;
}
