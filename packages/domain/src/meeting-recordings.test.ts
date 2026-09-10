import { describe, expect, it, vi } from "vitest";
import {
  ensureOwnedRecording,
  getMeetingRecordingStoragePath,
  getOwnedMeetingRecording,
  MEETING_RECORDINGS_BUCKET,
  RecordingStorageMismatchError,
  type RecordingStorageClient,
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

function fakeRecordingsTable(insertSpy: (payload: unknown) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      if (table !== "meeting_recordings") throw new Error(`unexpected table: ${table}`);
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          return { data: null, error: null }; // no existing row
        },
        insert(payload: unknown) {
          builder._insertPayload = payload;
          return builder;
        },
        async single() {
          return insertSpy(builder._insertPayload);
        },
        _insertPayload: undefined as unknown,
      };
      return builder;
    },
  } as unknown as Parameters<typeof ensureOwnedRecording>[0];
}

function fakeVexaFetch(mediaBytes: ArrayBuffer): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/recordings?meeting_id=")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: 860952982728,
              status: "completed",
              media_files: [{ id: 559299580948, type: "audio", format: "webm", file_size_bytes: mediaBytes.byteLength }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/media/")) {
      return new Response(mediaBytes, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

describe("ensureOwnedRecording — fresh ingestion", () => {
  it("downloads from Vexa, uploads to Storage, inserts the row, and returns the bytes — when nothing is owned yet", async () => {
    const mediaBytes = new TextEncoder().encode("fake-audio-bytes").buffer;
    const insertSpy = vi.fn((payload: unknown) => ({
      data: {
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: mediaBytes.byteLength,
        duration_seconds: null,
        checksum_sha256: expect.any(String),
        captured_at: null,
      },
      error: null,
    }));
    const supabase = fakeRecordingsTable(insertSpy);

    const uploadSpy = vi.fn(async () => ({ error: null }));
    const infoSpy = vi.fn(async () => ({ data: null, error: { message: "not found" } })); // nothing at the path yet
    const storage: RecordingStorageClient = {
      upload: uploadSpy,
      download: vi.fn(),
      info: infoSpy,
    };

    const result = await ensureOwnedRecording(supabase, storage, {
      organizationId: "org-1",
      meetingId: "meeting-1",
      vexaMeetingId: 28075,
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
      fetchImpl: fakeVexaFetch(mediaBytes),
    });

    expect(infoSpy).toHaveBeenCalledWith("organizations/org-1/meetings/meeting-1/original.webm");
    expect(uploadSpy).toHaveBeenCalledWith(
      "organizations/org-1/meetings/meeting-1/original.webm",
      expect.anything(),
      { contentType: "audio/webm", upsert: false },
    );
    expect(insertSpy).toHaveBeenCalled();
    expect(result.recordingRef.storagePath).toBe("organizations/org-1/meetings/meeting-1/original.webm");
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(mediaBytes));
  });

  it("throws RecordingNotReadyError when Vexa has no completed recording yet — reuses the existing error, no new retry classification needed", async () => {
    const supabase = fakeRecordingsTable(vi.fn());
    const storage: RecordingStorageClient = { upload: vi.fn(), download: vi.fn(), info: vi.fn() };
    const noRecordingFetch = (async (url: string | URL) => {
      if (String(url).includes("/recordings?meeting_id=")) {
        return new Response(JSON.stringify({ recordings: [] }), { status: 200 });
      }
      throw new Error("should not reach media download");
    }) as unknown as typeof fetch;

    await expect(
      ensureOwnedRecording(supabase, storage, {
        organizationId: "org-1",
        meetingId: "meeting-1",
        vexaMeetingId: 28075,
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
        fetchImpl: noRecordingFetch,
      }),
    ).rejects.toThrow("No completed Vexa recording is available for this meeting yet.");
  });
});

describe("ensureOwnedRecording — crash recovery (object exists, no DB row)", () => {
  it("reconciles without re-uploading or re-downloading when the existing object matches Vexa's reported size", async () => {
    const expectedSize = 474476;
    const insertSpy = vi.fn((payload: unknown) => ({
      data: {
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: expectedSize,
        duration_seconds: null,
        checksum_sha256: null, // never computed — we didn't download it ourselves this time
        captured_at: null,
      },
      error: null,
    }));
    const supabase = fakeRecordingsTable(insertSpy);

    const downloadedBytes = new TextEncoder().encode("x".repeat(expectedSize)).buffer;
    const uploadSpy = vi.fn(); // must NEVER be called in this test
    const downloadSpy = vi.fn(async () => ({ data: new Blob([downloadedBytes]), error: null }));
    const infoSpy = vi.fn(async () => ({ data: { size: expectedSize, contentType: "audio/webm" }, error: null }));
    const storage: RecordingStorageClient = { upload: uploadSpy, download: downloadSpy, info: infoSpy };

    const result = await ensureOwnedRecording(supabase, storage, {
      organizationId: "org-1",
      meetingId: "meeting-1",
      vexaMeetingId: 28075,
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
      fetchImpl: fakeVexaFetch(new ArrayBuffer(expectedSize)),
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalled();
    expect(result.recordingRef.byteSize).toBe(expectedSize);
  });

  it("fails closed — never overwrites — when the existing object's size does not match Vexa's reported size", async () => {
    const insertSpy = vi.fn();
    const supabase = fakeRecordingsTable(insertSpy);

    const uploadSpy = vi.fn();
    const infoSpy = vi.fn(async () => ({ data: { size: 999, contentType: "audio/webm" }, error: null })); // wrong size
    const storage: RecordingStorageClient = { upload: uploadSpy, download: vi.fn(), info: infoSpy };

    await expect(
      ensureOwnedRecording(supabase, storage, {
        organizationId: "org-1",
        meetingId: "meeting-1",
        vexaMeetingId: 28075,
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
        fetchImpl: fakeVexaFetch(new ArrayBuffer(474476)), // Vexa says 474476, Storage has 999
      }),
    ).rejects.toBeInstanceOf(RecordingStorageMismatchError);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
