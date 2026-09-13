import { describe, expect, it } from "vitest";
import {
  listCloudRecordings,
  getOnlineMeetingIdByJoinUrl,
  downloadGraphRecording,
} from "./graph-recording";
import { GraphApiError } from "./errors";

function capturingFetch(status: number, body: unknown) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

describe("listCloudRecordings", () => {
  it("uses user-scoped API path /users/{userOid}/onlineMeetings/{id}/recordings with GUID", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const { fetchImpl, calls } = capturingFetch(200, {
      value: [
        {
          id: "rec-1",
          meetingId: "meeting-123",
          createdDateTime: "2026-09-13T10:00:00Z",
          recordingContentUrl: "https://graph.microsoft.com/v1.0/...",
          meetingOrganizer: {
            user: {
              id: "user-1",
              displayName: "Test User",
              userIdentityType: "aadUser",
            },
          },
        },
      ],
    });

    const recordings = await listCloudRecordings(
      "access-token",
      userGuid,
      "meeting-123",
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/users/${userGuid}/onlineMeetings/meeting-123/recordings`);
    expect(calls[0]).not.toContain("/communications/");
    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.id).toBe("rec-1");
  });

  it("returns empty array when no recordings exist", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const { fetchImpl } = capturingFetch(200, { value: [] });

    const recordings = await listCloudRecordings(
      "access-token",
      userGuid,
      "meeting-123",
      fetchImpl,
    );

    expect(recordings).toEqual([]);
  });

  it("rejects email addresses as userOid (Graph requires GUID for app-only auth)", async () => {
    const email = "user@example.com";
    const { fetchImpl } = capturingFetch(400, {
      error: { 
        code: "BadRequest", 
        message: "The userId in request URL is not a valid GUID." 
      },
    });

    await expect(
      listCloudRecordings("access-token", email, "meeting-123", fetchImpl),
    ).rejects.toBeInstanceOf(GraphApiError);
  });

  it("throws GraphApiError on 404 (meeting not found or access denied)", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const { fetchImpl } = capturingFetch(404, {
      error: { code: "NotFound", message: "Requested API is not supported" },
    });

    await expect(
      listCloudRecordings("access-token", userGuid, "meeting-123", fetchImpl),
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("getOnlineMeetingIdByJoinUrl", () => {
  it("resolves online meeting ID from join URL using user-scoped API with GUID", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123";
    const { fetchImpl, calls } = capturingFetch(200, {
      value: [{ id: "online-meeting-456" }],
    });

    const meetingId = await getOnlineMeetingIdByJoinUrl(
      "access-token",
      userGuid,
      joinUrl,
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`/users/${userGuid}/onlineMeetings`);
    expect(calls[0]).toContain("$filter=");
    expect(calls[0]).toContain("JoinWebUrl");
    expect(meetingId).toBe("online-meeting-456");
  });

  it("returns null when no meeting matches the join URL", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz";
    const { fetchImpl } = capturingFetch(200, { value: [] });

    const meetingId = await getOnlineMeetingIdByJoinUrl(
      "access-token",
      userGuid,
      joinUrl,
      fetchImpl,
    );

    expect(meetingId).toBeNull();
  });

  it("escapes single quotes in join URL for OData filter", async () => {
    const userGuid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const joinUrl = "https://teams.example.com/join?q=test'value";
    const { fetchImpl, calls } = capturingFetch(200, { value: [] });

    await getOnlineMeetingIdByJoinUrl(
      "access-token",
      userGuid,
      joinUrl,
      fetchImpl,
    );

    // OData requires single quotes in strings to be escaped as ''
    expect(calls[0]).toContain("test''value");
  });
});

describe("downloadGraphRecording", () => {
  function capturingFetchWithHeaders(status: number, body: ArrayBuffer | string) {
    const capturedHeaders: Record<string, string>[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.headers) {
        capturedHeaders.push(init.headers as Record<string, string>);
      }
      return new Response(body, {
        status,
        headers: { "Content-Type": "video/mp4" },
      });
    };
    return { fetchImpl, capturedHeaders };
  }

  it("includes Authorization header with access token", async () => {
    const mockMp4Data = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]).buffer;
    const { fetchImpl, capturedHeaders } = capturingFetchWithHeaders(200, mockMp4Data);

    await downloadGraphRecording(
      "https://graph.microsoft.com/v1.0/users/xxx/onlineMeetings/yyy/recordings/zzz/content",
      "test-access-token",
      fetchImpl as unknown as typeof fetch,
    );

    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.Authorization).toBe("Bearer test-access-token");
  });

  it("throws error on 401 Unauthorized (missing or invalid token)", async () => {
    const { fetchImpl } = capturingFetchWithHeaders(401, "Unauthorized");

    await expect(
      downloadGraphRecording(
        "https://graph.microsoft.com/v1.0/users/xxx/onlineMeetings/yyy/recordings/zzz/content",
        "invalid-token",
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Failed to download recording: HTTP 401");
  });

  it("downloads and returns MP4 file as ArrayBuffer", async () => {
    const mockMp4Data = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]).buffer;
    const { fetchImpl } = capturingFetchWithHeaders(200, mockMp4Data);

    const result = await downloadGraphRecording(
      "https://graph.microsoft.com/v1.0/users/xxx/onlineMeetings/yyy/recordings/zzz/content",
      "test-access-token",
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.byteLength).toBe(8);
    expect(new Uint8Array(result)).toEqual(new Uint8Array(mockMp4Data));
  });
});
