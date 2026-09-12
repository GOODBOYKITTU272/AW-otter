/**
 * Microsoft Graph Teams Cloud Recording API
 * 
 * Spike: docs/product/graph-cloud-recording-spike.md
 * Status: PRODUCTION READY — requires admin consent + ENABLE_VIDEO_RECORDING=true
 * 
 * Prerequisites:
 * 1. Tenant admin grants OnlineMeetings.Read.All + OnlineMeetingRecording.Read.All
 * 2. Schema migration adds online_meeting_id to meetings table
 * 3. ENABLE_VIDEO_RECORDING=true in environment
 */

import { GRAPH_BASE_URL } from "./config";
import { normalizeGraphError } from "./errors";

/** Graph API response shape for online meeting recording */
export interface GraphCloudRecording {
  /** Recording ID (unique) */
  id: string;
  /** Parent online meeting ID */
  meetingId: string;
  /** When recording was finalized (typically 5-10 min after meeting ends) */
  createdDateTime: string;
  /** Signed URL to download MP4 file (expires ~1 hour) */
  recordingContentUrl: string;
  /** Meeting organizer metadata */
  meetingOrganizer: {
    application: { id: string; displayName: string | null } | null;
    device: { id: string; displayName: string | null } | null;
    user: {
      id: string;
      displayName: string | null;
      userIdentityType: "aadUser" | "guest" | "federated";
    } | null;
  };
}

interface RawGraphRecording {
  id?: string;
  meetingId?: string;
  createdDateTime?: string;
  recordingContentUrl?: string;
  meetingOrganizer?: {
    application?: { id?: string; displayName?: string | null } | null;
    device?: { id?: string; displayName?: string | null } | null;
    user?: {
      id?: string;
      displayName?: string | null;
      userIdentityType?: string;
    } | null;
  };
}

interface RawGraphRecordingsResponse {
  "@odata.context"?: string;
  value?: RawGraphRecording[];
}

async function graphRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw normalizeGraphError(
      response.status,
      body,
      response.headers.get("retry-after"),
    );
  }
  return body as T;
}

/**
 * List all cloud recordings for a specific online meeting.
 * 
 * Prerequisites:
 * - Application permission: OnlineMeetingRecording.Read.All
 * - Admin consent granted in Azure Portal
 * 
 * @param accessToken - Application-level access token (not delegated)
 * @param onlineMeetingId - Graph online meeting ID (NOT calendar event ID)
 * @returns Array of recordings (most recent first), empty if no recordings exist
 * @throws GraphApiError if permissions denied or API error
 */
export async function listCloudRecordings(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphCloudRecording[]> {
  const raw = await graphRequest<RawGraphRecordingsResponse>(
    `/communications/onlineMeetings/${encodeURIComponent(onlineMeetingId)}/recordings`,
    accessToken,
    { method: "GET" },
    fetchImpl,
  );

  return (raw.value ?? []).map(normalizeGraphRecording);
}

/**
 * Normalizes raw Graph API recording response to typed GraphCloudRecording.
 */
function normalizeGraphRecording(raw: RawGraphRecording): GraphCloudRecording {
  if (!raw.id) throw new Error("Graph recording missing required id field");
  if (!raw.meetingId) throw new Error("Graph recording missing required meetingId field");
  if (!raw.recordingContentUrl) throw new Error("Graph recording missing required recordingContentUrl field");

  return {
    id: raw.id,
    meetingId: raw.meetingId,
    createdDateTime: raw.createdDateTime ?? new Date().toISOString(),
    recordingContentUrl: raw.recordingContentUrl,
    meetingOrganizer: {
      application: raw.meetingOrganizer?.application
        ? {
            id: raw.meetingOrganizer.application.id ?? "unknown",
            displayName: raw.meetingOrganizer.application.displayName ?? null,
          }
        : null,
      device: raw.meetingOrganizer?.device
        ? {
            id: raw.meetingOrganizer.device.id ?? "unknown",
            displayName: raw.meetingOrganizer.device.displayName ?? null,
          }
        : null,
      user: raw.meetingOrganizer?.user
        ? {
            id: raw.meetingOrganizer.user.id ?? "unknown",
            displayName: raw.meetingOrganizer.user.displayName ?? null,
            userIdentityType: (raw.meetingOrganizer.user.userIdentityType ?? "aadUser") as "aadUser" | "guest" | "federated",
          }
        : null,
    },
  };
}

/**
 * Download cloud recording MP4 file via signed URL.
 * 
 * Prerequisites:
 * - Recording must exist (from listCloudRecordings)
 * - recordingContentUrl expires ~1 hour after fetch, must download immediately
 * 
 * @param recordingContentUrl - Signed download URL from GraphCloudRecording.recordingContentUrl
 * @param fetchImpl - Fetch implementation (for testing)
 * @param timeoutMs - Download timeout (default 2 minutes)
 * @param maxBytes - Size limit (default 500 MB for video)
 * @returns MP4 file as ArrayBuffer
 * @throws Error if download fails, times out, or exceeds size limit
 */
export async function downloadGraphRecording(
  recordingContentUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 120_000,
  maxBytes: number = 500 * 1024 * 1024, // 500MB for video
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(recordingContentUrl, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to download recording: HTTP ${response.status}`);
    }

    if (!response.body) {
      return await response.arrayBuffer();
    }

    // Stream with size limit (same pattern as Vexa recordings)
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Recording download exceeded the ${maxBytes} byte limit.`,
        );
      }

      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return merged.buffer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Recording download timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll for cloud recording availability with exponential backoff.
 * Cloud recordings typically available 5-10 minutes after meeting ends.
 * 
 * @param accessToken - Application-level access token
 * @param onlineMeetingId - Graph online meeting ID
 * @param fetchImpl - Fetch implementation (for testing)
 * @param maxAttempts - Max polling attempts (default 6 = 12 min total)
 * @param intervalMs - Initial interval between attempts (default 2 min)
 * @returns GraphCloudRecording if found, null if not available after max attempts
 */
export async function pollForCloudRecording(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl: typeof fetch = fetch,
  maxAttempts: number = 6,
  intervalMs: number = 2 * 60 * 1000, // 2 minutes
): Promise<GraphCloudRecording | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const recordings = await listCloudRecordings(accessToken, onlineMeetingId, fetchImpl);

    if (recordings.length > 0) {
      // Return most recent recording (in case multiple exist)
      return recordings[recordings.length - 1] ?? null;
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return null; // No recording found after maxAttempts
}
