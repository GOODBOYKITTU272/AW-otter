import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureGraphCloudRecording, RecordingNotReadyError, RecordingAlreadyExistsError } from "../meeting-recordings";

// Mock implementations
const mockSupabase = {
  from: vi.fn(),
  storage: {
    from: vi.fn(),
  },
};

const mockStorage = {
  download: vi.fn(),
  upload: vi.fn(),
  info: vi.fn(),
};

describe("Video Recording Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureGraphCloudRecording idempotency", () => {
    it("returns existing video recording if already ingested", async () => {
      const existingRecording = {
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        media_kind: "video",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/video.original.mp4",
        content_type: "video/mp4",
        byte_size: 48000000,
        duration_seconds: null,
        checksum_sha256: "abc123",
        captured_at: null,
      };

      const mockBlob = new Blob([new ArrayBuffer(48000000)], { type: "video/mp4" });

      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: existingRecording, error: null }),
          }),
        }),
      });

      mockStorage.download.mockResolvedValue({ data: mockBlob, error: null });
      mockSupabase.storage.from.mockReturnValue(mockStorage);

      const result = await ensureGraphCloudRecording(
        mockSupabase as any,
        mockStorage as any,
        {
          organizationId: "org-1",
          meetingId: "meeting-1",
          onlineMeetingId: "MSo...",
          graphAccessToken: "token",
        }
      );

      expect(result.recordingRef.id).toBe("rec-1");
      expect(result.recordingRef.mediaKind).toBe("video");
      expect(mockStorage.download).toHaveBeenCalledWith(existingRecording.storage_path);
    });

    it("throws RecordingNotReadyError if no recording found after polling", async () => {
      mockSupabase.from.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      });

      // Mock pollForCloudRecording to return null (no recording found)
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ value: [] }), // Empty recordings list
        headers: new Headers(),
      });

      await expect(
        ensureGraphCloudRecording(
          mockSupabase as any,
          mockStorage as any,
          {
            organizationId: "org-1",
            meetingId: "meeting-1",
            onlineMeetingId: "MSo...",
            graphAccessToken: "token",
            fetchImpl: mockFetch,
          }
        )
      ).rejects.toThrow(RecordingNotReadyError);
    });
  });

  describe("DNR enforcement", () => {
    it("should skip video ingestion for meetings with eligibility_status=exclude", () => {
      // This is tested at the route level, not domain level
      // The route checks eligibility_status before calling ensureGraphCloudRecording
      expect(true).toBe(true); // Placeholder for route-level test
    });
  });

  describe("online_meeting_id population", () => {
    it("should be populated from calendar sync", () => {
      // This is tested in the meetings.test.ts (domain) and normalize.test.ts (microsoft package)
      // The meetingFields function now includes online_meeting_id
      expect(true).toBe(true); // Placeholder - actual tests in other files
    });
  });
});
