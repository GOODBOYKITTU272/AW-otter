import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  ensureGraphCloudRecording,
  RecordingNotReadyError,
  RecordingAlreadyExistsError,
  MEETING_RECORDINGS_BUCKET,
  type RecordingStorageClient,
} from "@applywizz/domain/meeting-recordings";
import { evaluateMeetingPolicy } from "@applywizz/domain/meeting-policy";
import { logAuditEvent } from "@applywizz/domain/audit";
import { getFeatureFlags } from "@applywizz/domain/feature-flags";
import { getAppOnlyAccessToken } from "@applywizz/microsoft";
import {
  getSupabaseServiceRoleKey,
  getMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { isAuthorizedInternalRequest } from "@/lib/internal-route-auth";

/**
 * Internal route: Ingest Graph cloud recording for completed meetings.
 * 
 * Flow:
 * 1. Find completed meetings with online_meeting_id (within last 7 days)
 * 2. Check feature flag (ENABLE_VIDEO_RECORDING)
 * 3. Check DNR (eligibility_status != 'exclude')
 * 4. Call ensureGraphCloudRecording (best-effort, never fail audio/transcript)
 * 5. Log success/failure
 * 
 * Called from scheduled cron OR manually triggered for one meetingId.
 */

interface IngestResult {
  meetingId: string;
  status: "success" | "skipped_dnr" | "skipped_no_online_id" | "not_ready" | "already_exists" | "error";
  message?: string;
}

/**
 * Resolve organizer email to Azure AD object ID (GUID) required for Graph API.
 * 
 * Graph's /users/{userOid}/onlineMeetings/... path requires an Azure AD object ID,
 * not UPN/email. This looks up the provider_user_id from calendar_connections
 * by matching the organizer email in scope_metadata.
 * 
 * @param serviceRoleClient - Supabase service role client
 * @param organizerEmail - Organizer email from meeting record (case-insensitive)
 * @returns Azure AD object ID (GUID) if found, null otherwise
 */
async function resolveOrganizerToGuid(
  serviceRoleClient: ReturnType<typeof createSupabaseServiceRoleClient>,
  organizerEmail: string,
): Promise<string | null> {
  // Query calendar_connections where scope_metadata->>'email' matches organizer_email (case-insensitive)
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

async function ingestVideoForMeeting(
  serviceRoleClient: ReturnType<typeof createSupabaseServiceRoleClient>,
  meetingId: string,
  graphAccessToken: string,
): Promise<IngestResult> {
  const flags = getFeatureFlags();
  if (!flags.enableVideoRecording) {
    return { meetingId, status: "skipped_dnr", message: "Video recording disabled by feature flag" };
  }

  // Fetch meeting with all necessary fields including organizer_email and meeting_url
  const { data: meeting, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("id, organization_id, online_meeting_id, organizer_email, meeting_url, eligibility_status, lifecycle_status")
    .eq("id", meetingId)
    .single();

  if (meetingError) {
    return { meetingId, status: "error", message: meetingError.message };
  }

  // DNR check: if eligibility_status is 'exclude', skip video ingestion
  if (meeting.eligibility_status === "exclude") {
    await logAuditEvent(serviceRoleClient, {
      organizationId: meeting.organization_id,
      actorId: null,
      action: "recording.video_ingestion_skipped_dnr",
      entityType: "meeting",
      entityId: meeting.id,
      metadata: { reason: "DNR participant present" },
    });
    return { meetingId, status: "skipped_dnr", message: "DNR participant detected" };
  }

  // Require organizer_email to resolve the user-scoped API path
  if (!meeting.organizer_email) {
    return { meetingId, status: "skipped_no_online_id", message: "No organizer_email present" };
  }

  let onlineMeetingId = meeting.online_meeting_id;

  // If online_meeting_id is missing but meeting_url exists, try to resolve it
  if (!onlineMeetingId && meeting.meeting_url) {
    // First resolve organizer email to GUID for the lookup
    const lookupUserOid = await resolveOrganizerToGuid(serviceRoleClient, meeting.organizer_email);
    if (!lookupUserOid) {
      return { 
        meetingId, 
        status: "error", 
        message: `Cannot resolve organizer ${meeting.organizer_email} to Azure AD object ID - no active calendar connection found` 
      };
    }

    try {
      const { getOnlineMeetingIdByJoinUrl } = await import("@applywizz/microsoft");
      const resolvedId = await getOnlineMeetingIdByJoinUrl(
        graphAccessToken,
        lookupUserOid,
        meeting.meeting_url,
      );
      
      if (resolvedId) {
        onlineMeetingId = resolvedId;
        // Persist the resolved online_meeting_id for future use
        await serviceRoleClient
          .from("meetings")
          .update({ online_meeting_id: resolvedId })
          .eq("id", meeting.id);
      }
    } catch (error) {
      return { 
        meetingId, 
        status: "error", 
        message: `Failed to resolve online_meeting_id: ${error instanceof Error ? error.message : String(error)}` 
      };
    }
  }

  if (!onlineMeetingId) {
    return { meetingId, status: "skipped_no_online_id", message: "No online_meeting_id or meeting_url to resolve it" };
  }

  // Resolve organizer email to Azure AD object ID (GUID) required by Graph API
  const userOid = await resolveOrganizerToGuid(serviceRoleClient, meeting.organizer_email);
  if (!userOid) {
    return { 
      meetingId, 
      status: "error", 
      message: `Cannot resolve organizer ${meeting.organizer_email} to Azure AD object ID - no active calendar connection found` 
    };
  }

  // Get storage client (cast to expected interface - actual Supabase storage is compatible)
  const storage = serviceRoleClient.storage.from(MEETING_RECORDINGS_BUCKET) as unknown as RecordingStorageClient;

  try {
    await ensureGraphCloudRecording(serviceRoleClient, storage, {
      organizationId: meeting.organization_id,
      meetingId: meeting.id,
      onlineMeetingId,
      userOid,
      graphAccessToken,
    });

    await logAuditEvent(serviceRoleClient, {
      organizationId: meeting.organization_id,
      actorId: null,
      action: "recording.video_ingestion_success",
      entityType: "meeting",
      entityId: meeting.id,
      metadata: { onlineMeetingId },
    });

    return { meetingId, status: "success" };
  } catch (error) {
    if (error instanceof RecordingNotReadyError) {
      return { meetingId, status: "not_ready", message: "Recording not yet available" };
    }
    if (error instanceof RecordingAlreadyExistsError) {
      return { meetingId, status: "already_exists", message: "Recording already ingested" };
    }
    
    await logAuditEvent(serviceRoleClient, {
      organizationId: meeting.organization_id,
      actorId: null,
      action: "recording.video_ingestion_error",
      entityType: "meeting",
      entityId: meeting.id,
      metadata: { 
        error: error instanceof Error ? error.message : String(error),
        onlineMeetingId,
      },
    });

    return { 
      meetingId, 
      status: "error", 
      message: error instanceof Error ? error.message : String(error) 
    };
  }
}

/**
 * POST /api/internal/video-recordings/ingest
 * 
 * Manual trigger (for testing): POST with { meetingId: "uuid" }
 * Scheduled batch: POST with no body (processes all eligible meetings)
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

  // Get Microsoft credentials for app-only access token
  const microsoftEnv = getMicrosoftEnv();
  const { accessToken: graphAccessToken } = await getAppOnlyAccessToken(
    {
      tenantId: microsoftEnv.MICROSOFT_TENANT_ID,
      clientId: microsoftEnv.MICROSOFT_CLIENT_ID,
      clientSecret: microsoftEnv.MICROSOFT_CLIENT_SECRET,
    },
  );

  let body: { meetingId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // No body = batch mode
  }

  // Manual trigger mode: single meeting
  if (body.meetingId) {
    const result = await ingestVideoForMeeting(
      serviceRoleClient,
      body.meetingId,
      graphAccessToken,
    );
    return NextResponse.json({ results: [result] }, { status: 200 });
  }

  // Batch mode: find all completed meetings with online_meeting_id (last 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: meetings, error: meetingsError } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("lifecycle_status", "completed")
    .not("online_meeting_id", "is", null)
    .gte("scheduled_start", sevenDaysAgo)
    .limit(50); // Batch size limit

  if (meetingsError) {
    return NextResponse.json({ error: meetingsError.message }, { status: 500 });
  }

  const results: IngestResult[] = [];
  for (const meeting of meetings ?? []) {
    const result = await ingestVideoForMeeting(
      serviceRoleClient,
      meeting.id,
      graphAccessToken,
    );
    results.push(result);
  }

  return NextResponse.json({ 
    results,
    summary: {
      total: results.length,
      success: results.filter(r => r.status === "success").length,
      skipped_dnr: results.filter(r => r.status === "skipped_dnr").length,
      not_ready: results.filter(r => r.status === "not_ready").length,
      already_exists: results.filter(r => r.status === "already_exists").length,
      errors: results.filter(r => r.status === "error").length,
    }
  }, { status: 200 });
}

export const GET = POST;
