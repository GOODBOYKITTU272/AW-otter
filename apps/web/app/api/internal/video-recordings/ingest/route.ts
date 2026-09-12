import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  ensureGraphCloudRecording,
  RecordingNotReadyError,
  RecordingAlreadyExistsError,
  MEETING_RECORDINGS_BUCKET,
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

async function ingestVideoForMeeting(
  serviceRoleClient: ReturnType<typeof createSupabaseServiceRoleClient>,
  meetingId: string,
  graphAccessToken: string,
): Promise<IngestResult> {
  const flags = getFeatureFlags();
  if (!flags.enableVideoRecording) {
    return { meetingId, status: "skipped_dnr", message: "Video recording disabled by feature flag" };
  }

  // Fetch meeting with all necessary fields
  const { data: meeting, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("id, organization_id, online_meeting_id, eligibility_status, lifecycle_status")
    .eq("id", meetingId)
    .single();

  if (meetingError) {
    return { meetingId, status: "error", message: meetingError.message };
  }

  if (!meeting.online_meeting_id) {
    return { meetingId, status: "skipped_no_online_id", message: "No online_meeting_id present" };
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

  // Get storage client
  const storage = serviceRoleClient.storage.from(MEETING_RECORDINGS_BUCKET);

  try {
    await ensureGraphCloudRecording(serviceRoleClient, storage, {
      organizationId: meeting.organization_id,
      meetingId: meeting.id,
      onlineMeetingId: meeting.online_meeting_id,
      graphAccessToken,
    });

    await logAuditEvent(serviceRoleClient, {
      organizationId: meeting.organization_id,
      actorId: null,
      action: "recording.video_ingestion_success",
      entityType: "meeting",
      entityId: meeting.id,
      metadata: { onlineMeetingId: meeting.online_meeting_id },
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
        onlineMeetingId: meeting.online_meeting_id,
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
      tenantId: microsoftEnv.tenantId,
      clientId: microsoftEnv.clientId,
      clientSecret: microsoftEnv.clientSecret,
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
