import { describe, expect, it } from "vitest";
import {
  getMeetingRecordingStoragePath,
  getOwnedMeetingRecording,
  MEETING_RECORDINGS_BUCKET,
} from "./meeting-recordings";

describe("getMeetingRecordingStoragePath", () => {
  it("builds the exact deterministic path from the spec", () => {
    const path = getMeetingRecordingStoragePath(
      "98000000-0000-0000-0000-0000000000c1",
      "98300000-0000-0000-0000-0000000000c1",
      "webm",
    );
    expect(path).toBe(
      "organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/original.webm",
    );
  });

  it("is the ONLY place path construction happens — same inputs always produce the same path", () => {
    const a = getMeetingRecordingStoragePath("org-1", "meeting-1", "webm");
    const b = getMeetingRecordingStoragePath("org-1", "meeting-1", "webm");
    expect(a).toBe(b);
  });
});

describe("MEETING_RECORDINGS_BUCKET", () => {
  it("matches the bucket created in the migration", () => {
    expect(MEETING_RECORDINGS_BUCKET).toBe("meeting-recordings");
  });
});

function fakeSupabase(row: unknown) {
  return {
    from(table: string) {
      if (table !== "meeting_recordings") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: row, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof getOwnedMeetingRecording>[0];
}

describe("getOwnedMeetingRecording", () => {
  it("returns null when no recording is owned yet", async () => {
    const result = await getOwnedMeetingRecording(fakeSupabase(null), "meeting-1");
    expect(result).toBeNull();
  });

  it("maps the real row shape to OwnedRecordingRef", async () => {
    const result = await getOwnedMeetingRecording(
      fakeSupabase({
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: 474476,
        duration_seconds: null,
        checksum_sha256: "abc123",
        captured_at: null,
      }),
      "meeting-1",
    );
    expect(result).toEqual({
      id: "rec-1",
      organizationId: "org-1",
      meetingId: "meeting-1",
      storageBucket: "meeting-recordings",
      storagePath: "organizations/org-1/meetings/meeting-1/original.webm",
      contentType: "audio/webm",
      byteSize: 474476,
      durationSeconds: null,
      checksumSha256: "abc123",
      capturedAt: null,
    });
  });
});
