import { describe, expect, it } from "vitest";
import { getMeetingRecordingStoragePath, MEETING_RECORDINGS_BUCKET } from "./meeting-recordings";

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
