import { describe, expect, it, vi } from "vitest";
import {
  analyzeMeetingIntegrity,
  evaluateAndPersistMeetingIntegrity,
  saveMeetingIntegrityReport,
} from "./meeting-integrity";

describe("analyzeMeetingIntegrity", () => {
  it("returns insufficient_speech for empty segments and null confidence", () => {
    const res = analyzeMeetingIntegrity({ segments: [] });
    expect(res.verdict).toBe("insufficient_speech");
    expect(res.confidenceScoreAvg).toBeNull();
    expect(res.flags).toHaveLength(0);
  });

  describe("Confidence Score Averaging (Blocker 3)", () => {
    it("computes average when all confidence values are known", () => {
      const res = analyzeMeetingIntegrity({
        segments: [
          { id: "s1", startMs: 0, endMs: 5000, text: "Hello", confidence: 0.9 },
          { id: "s2", startMs: 5000, endMs: 10000, text: "World", confidence: 0.8 },
        ],
      });
      expect(res.confidenceScoreAvg).toBe(0.85);
    });

    it("averages only known confidence values when mixed", () => {
      const res = analyzeMeetingIntegrity({
        segments: [
          { id: "s1", startMs: 0, endMs: 5000, text: "Hello", confidence: 0.9 },
          { id: "s2", startMs: 5000, endMs: 10000, text: "World", confidence: null },
          { id: "s3", startMs: 10000, endMs: 15000, text: "There", confidence: 0.7 },
        ],
      });
      expect(res.confidenceScoreAvg).toBe(0.8);
    });

    it("returns null when all confidence values are unknown", () => {
      const res = analyzeMeetingIntegrity({
        segments: [
          { id: "s1", startMs: 0, endMs: 5000, text: "Hello", confidence: null },
          { id: "s2", startMs: 5000, endMs: 10000, text: "World" },
        ],
      });
      expect(res.confidenceScoreAvg).toBeNull();
    });
  });

  describe("Transcript Heuristic Terminology (Blocker 4)", () => {
    it("detects background media / STT artifact tokens", () => {
      const res = analyzeMeetingIntegrity({
        durationSeconds: 120,
        segments: [
          {
            id: "s1",
            startMs: 0,
            endMs: 15000,
            text: "Hello, welcome to ApplyWizz [music]",
          },
          {
            id: "s2",
            startMs: 16000,
            endMs: 35000,
            text: "Hi there ♪ thanks for having me ♪",
          },
        ],
      });

      expect(res.suspectedBackgroundMedia).toBe(true);
      expect(res.verdict).toBe("suspected_background_media");
      const mediaFlags = res.flags.filter(
        (f) => f.flagType === "possible_background_media_or_stt_artifact",
      );
      expect(mediaFlags).toHaveLength(2);
      expect(mediaFlags[0]?.message).toContain("Possible background media or STT artifact");
    });

    it("detects transcript speech gaps with truthful wording", () => {
      const res = analyzeMeetingIntegrity({
        durationSeconds: 120,
        segments: [
          { id: "s1", startMs: 0, endMs: 5000, text: "First topic discussed." },
          { id: "s2", startMs: 35000, endMs: 45000, text: "Resuming conversation." },
        ],
      });

      const gapFlags = res.flags.filter((f) => f.flagType === "transcript_speech_gap");
      expect(gapFlags).toHaveLength(1);
      expect(gapFlags[0]?.message).toContain("No transcribed speech in this interval");
    });

    it("detects repetitive hallucination loops in silence", () => {
      const res = analyzeMeetingIntegrity({
        durationSeconds: 90,
        segments: [
          { id: "s1", startMs: 0, endMs: 12000, text: "Let us discuss your profile." },
          { id: "s2", startMs: 13000, endMs: 18000, text: "Thank you for watching." },
          { id: "s3", startMs: 19000, endMs: 24000, text: "Thank you for watching." },
          { id: "s4", startMs: 25000, endMs: 30000, text: "Thank you for watching." },
        ],
      });

      expect(
        res.flags.some(
          (f) => f.flagType === "filler_loop" || f.flagType === "rapid_hallucination",
        ),
      ).toBe(true);
      expect(res.verdict).not.toBe("good");
    });

    it("produces good verdict for clean speech segments", () => {
      const res = analyzeMeetingIntegrity({
        durationSeconds: 100,
        segments: [
          {
            id: "s1",
            startMs: 0,
            endMs: 40000,
            text: "Let us review your resume and target role preferences.",
          },
          {
            id: "s2",
            startMs: 41000,
            endMs: 100000,
            text: "Yes, I am on STEM OPT and looking for senior distributed systems roles.",
          },
        ],
      });

      expect(res.verdict).toBe("good");
      expect(res.flags).toHaveLength(0);
    });
  });

  describe("saveMeetingIntegrityReport (Blocker 7: Atomic RPC)", () => {
    it("calls save_meeting_integrity_report_atomic RPC with correct arguments", async () => {
      const mockRpc = vi.fn().mockResolvedValue({
        data: { id: "report-123" },
        error: null,
      });
      const client = { rpc: mockRpc } as unknown as Parameters<
        typeof saveMeetingIntegrityReport
      >[0];

      const analysis = analyzeMeetingIntegrity({
        meetingId: "meeting-1",
        segments: [
          { id: "s1", startMs: 0, endMs: 15000, text: "Hello [music]", confidence: 0.95 },
        ],
      });

      const res = await saveMeetingIntegrityReport(client, {
        organizationId: "org-1",
        meetingId: "meeting-1",
        analysis,
      });

      expect(res.reportId).toBe("report-123");
      expect(mockRpc).toHaveBeenCalledWith(
        "save_meeting_integrity_report_atomic",
        expect.objectContaining({
          p_organization_id: "org-1",
          p_meeting_id: "meeting-1",
          p_overall_verdict: "suspected_background_media",
          p_confidence_score_avg: 0.95,
          p_suspected_background_media: true,
          p_flags: expect.arrayContaining([
            expect.objectContaining({
              flag_type: "possible_background_media_or_stt_artifact",
              transcript_segment_id: "s1",
            }),
          ]),
        }),
      );
    });
  });

  describe("evaluateAndPersistMeetingIntegrity (Gate 3 Confidence Truth)", () => {
    function createMockClient(segments: Array<{
      id: string;
      start_ms: number;
      end_ms: number;
      original_text: string;
      canonical_english_text?: string | null;
      speaker_label?: string | null;
      transcription_confidence?: number | null;
    }>) {
      const mockRpc = vi.fn().mockResolvedValue({
        data: { id: "report-eval-1" },
        error: null,
      });

      const mockFrom = vi.fn((table: string) => {
        if (table === "meeting_transcripts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({
              data: { id: "tr-1" },
              error: null,
            }),
          };
        }
        if (table === "transcript_segments") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: segments,
              error: null,
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      });

      return {
        client: { from: mockFrom, rpc: mockRpc } as unknown as Parameters<
          typeof evaluateAndPersistMeetingIntegrity
        >[0],
        mockRpc,
        mockFrom,
      };
    }

    it("wires all known transcription_confidence values from database segments into analysis and RPC", async () => {
      const { client, mockRpc, mockFrom } = createMockClient([
        {
          id: "seg-1",
          start_ms: 0,
          end_ms: 12000,
          original_text: "Let us review your resume.",
          transcription_confidence: 0.92,
        },
        {
          id: "seg-2",
          start_ms: 12000,
          end_ms: 25000,
          original_text: "Sure thing, here are my details.",
          transcription_confidence: 0.84,
        },
      ]);

      const analysis = await evaluateAndPersistMeetingIntegrity(
        client,
        "meeting-123",
        "org-abc",
      );

      // Verify transcription_confidence was queried
      expect(mockFrom).toHaveBeenCalledWith("transcript_segments");
      expect(analysis.confidenceScoreAvg).toBe(0.88);

      expect(mockRpc).toHaveBeenCalledWith(
        "save_meeting_integrity_report_atomic",
        expect.objectContaining({
          p_meeting_id: "meeting-123",
          p_confidence_score_avg: 0.88,
        }),
      );
    });

    it("wires mixed transcription_confidence values and ignores nulls in average", async () => {
      const { client, mockRpc } = createMockClient([
        {
          id: "seg-1",
          start_ms: 0,
          end_ms: 12000,
          original_text: "Let us review your resume.",
          transcription_confidence: 0.8,
        },
        {
          id: "seg-2",
          start_ms: 12000,
          end_ms: 25000,
          original_text: "Sure thing, here are my details.",
          transcription_confidence: null,
        },
      ]);

      const analysis = await evaluateAndPersistMeetingIntegrity(
        client,
        "meeting-123",
        "org-abc",
      );

      expect(analysis.confidenceScoreAvg).toBe(0.8);
      expect(mockRpc).toHaveBeenCalledWith(
        "save_meeting_integrity_report_atomic",
        expect.objectContaining({
          p_confidence_score_avg: 0.8,
        }),
      );
    });

    it("handles all null transcription_confidence values with null confidenceScoreAvg", async () => {
      const { client, mockRpc } = createMockClient([
        {
          id: "seg-1",
          start_ms: 0,
          end_ms: 12000,
          original_text: "Let us review your resume.",
          transcription_confidence: null,
        },
        {
          id: "seg-2",
          start_ms: 12000,
          end_ms: 25000,
          original_text: "Sure thing, here are my details.",
          transcription_confidence: null,
        },
      ]);

      const analysis = await evaluateAndPersistMeetingIntegrity(
        client,
        "meeting-123",
        "org-abc",
      );

      expect(analysis.confidenceScoreAvg).toBeNull();
      expect(mockRpc).toHaveBeenCalledWith(
        "save_meeting_integrity_report_atomic",
        expect.objectContaining({
          p_confidence_score_avg: null,
        }),
      );
    });
  });
});
