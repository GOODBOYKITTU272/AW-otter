import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { addEchoAttendeeToOnlineMeeting } from "@applywizz/microsoft";
import { getFeatureFlags } from "./feature-flags";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Track A: Automatically add Echo to Apply Wizz–organized Teams meetings.
 * 
 * When a meeting has an online_meeting_id, PATCH the Graph online meeting
 * to add Echo@Applywizz.ai (or Echo@applywizz.ai) as an attendee.
 * 
 * This ensures Echo is on the official attendee list, which may help with:
 * - Meeting access permissions
 * - Lobby admission (when combined with invited attendee policies)
 * - Audit trails and meeting participation tracking
 * 
 * Idempotent and best-effort:
 * - Logs success/failure but never throws
 * - Bot join proceeds regardless of PATCH outcome
 * - Requires OnlineMeetings.ReadWrite.All permission (same as lobby bypass)
 * - Graph deduplicates attendees automatically (safe to call multiple times)
 * 
 * @param serviceRoleClient - Supabase service role client
 * @param graphAccessToken - App-only Graph token with OnlineMeetings.ReadWrite.All
 * @param meetingId - Meeting UUID
 * @param onlineMeetingId - Graph online meeting ID (from meeting.online_meeting_id)
 * @param organizerEmail - Organizer email (to resolve to Azure AD GUID)
 * @param organizationId - Organization UUID (for audit logging)
 */
export async function addEchoAttendeeIfEnabled(
  serviceRoleClient: AppSupabaseClient,
  graphAccessToken: string,
  meetingId: string,
  onlineMeetingId: string,
  organizerEmail: string,
  organizationId: string,
): Promise<void> {
  const flags = getFeatureFlags();
  if (!flags.enableEchoAttendeeInvite) {
    return; // Feature disabled, silent no-op
  }

  try {
    // Resolve organizer email to Azure AD GUID
    const userOid = await resolveOrganizerToGuid(serviceRoleClient, organizerEmail);
    if (!userOid) {
      await logAuditEvent(serviceRoleClient, {
        organizationId,
        actorId: null,
        action: "meeting.echo_attendee_skipped_no_guid",
        entityType: "meeting",
        entityId: meetingId,
        metadata: { 
          reason: "Cannot resolve organizer to Azure AD GUID",
          organizerEmail,
        },
      });
      return;
    }

    // Get Echo's UPN from environment (verify exact casing in Entra)
    const echoUpn = process.env.ECHO_UPN || "Echo@Applywizz.ai";
    
    // Optional: Echo's object ID if available (improves Graph API reliability)
    const echoObjectId = process.env.ECHO_OBJECT_ID || null;

    // PATCH the online meeting to add Echo as attendee
    await addEchoAttendeeToOnlineMeeting(
      graphAccessToken,
      userOid,
      onlineMeetingId,
      echoUpn,
      echoObjectId,
    );

    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "meeting.echo_attendee_added",
      entityType: "meeting",
      entityId: meetingId,
      metadata: { onlineMeetingId, userOid, echoUpn },
    });
  } catch (error) {
    // Best-effort: log failure but don't propagate error
    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "meeting.echo_attendee_failed",
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
 * Same implementation as lobby bypass (packages/domain/src/lobby-bypass.ts).
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
