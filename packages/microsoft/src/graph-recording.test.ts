import { describe, expect, it } from "vitest";
import {
  listCloudRecordings,
  getOnlineMeetingIdByJoinUrl,
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
  it("uses user-scoped API path /users/{userOid}/onlineMeetings/{id}/recordings", async () => {
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
      "user@example.com",
      "meeting-123",
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/users/user%40example.com/onlineMeetings/meeting-123/recordings");
    expect(calls[0]).not.toContain("/communications/");
    expect(recordings).toHaveLength(1);
    expect(recordings[0]?.id).toBe("rec-1");
  });

  it("returns empty array when no recordings exist", async () => {
    const { fetchImpl } = capturingFetch(200, { value: [] });

    const recordings = await listCloudRecordings(
      "access-token",
      "user@example.com",
      "meeting-123",
      fetchImpl,
    );

    expect(recordings).toEqual([]);
  });

  it("throws GraphApiError on 404 (meeting not found or access denied)", async () => {
    const { fetchImpl } = capturingFetch(404, {
      error: { code: "NotFound", message: "Requested API is not supported" },
    });

    await expect(
      listCloudRecordings("access-token", "user@example.com", "meeting-123", fetchImpl),
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("getOnlineMeetingIdByJoinUrl", () => {
  it("resolves online meeting ID from join URL using user-scoped API", async () => {
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123";
    const { fetchImpl, calls } = capturingFetch(200, {
      value: [{ id: "online-meeting-456" }],
    });

    const meetingId = await getOnlineMeetingIdByJoinUrl(
      "access-token",
      "organizer@example.com",
      joinUrl,
      fetchImpl,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/users/organizer%40example.com/onlineMeetings");
    expect(calls[0]).toContain("$filter=");
    expect(calls[0]).toContain("JoinWebUrl");
    expect(meetingId).toBe("online-meeting-456");
  });

  it("returns null when no meeting matches the join URL", async () => {
    const joinUrl = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz";
    const { fetchImpl } = capturingFetch(200, { value: [] });

    const meetingId = await getOnlineMeetingIdByJoinUrl(
      "access-token",
      "organizer@example.com",
      joinUrl,
      fetchImpl,
    );

    expect(meetingId).toBeNull();
  });

  it("escapes single quotes in join URL for OData filter", async () => {
    const joinUrl = "https://teams.example.com/join?q=test'value";
    const { fetchImpl, calls } = capturingFetch(200, { value: [] });

    await getOnlineMeetingIdByJoinUrl(
      "access-token",
      "organizer@example.com",
      joinUrl,
      fetchImpl,
    );

    // OData requires single quotes in strings to be escaped as ''
    expect(calls[0]).toContain("test''value");
  });
});
