import { describe, expect, it } from "vitest";
import { analyzeMeetingIntegrity } from "./meeting-integrity";

describe("analyzeMeetingIntegrity", () => {
  it("returns insufficient_speech for empty segments", () => {
    const res = analyzeMeetingIntegrity({ segments: [] });
    expect(res.verdict).toBe("insufficient_speech");
    expect(res.usableSpeechPercentage).toBe(0);
    expect(res.flags).toHaveLength(0);
  });

  it("detects background media tokens and flags verdict", () => {
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

    expect(res.backgroundMediaDetected).toBe(true);
    expect(res.verdict).toBe("suspected_background_media");
    expect(res.flags.filter((f) => f.flagType === "background_media")).toHaveLength(2);
  });

  it("detects repetitive hallucination loops in silence", () => {
    const res = analyzeMeetingIntegrity({
      durationSeconds: 90,
      segments: [
        {
          id: "s1",
          startMs: 0,
          endMs: 12000,
          text: "Let us discuss your profile.",
        },
        {
          id: "s2",
          startMs: 13000,
          endMs: 18000,
          text: "Thank you for watching.",
        },
        {
          id: "s3",
          startMs: 19000,
          endMs: 24000,
          text: "Thank you for watching.",
        },
        {
          id: "s4",
          startMs: 25000,
          endMs: 30000,
          text: "Thank you for watching.",
        },
      ],
    });

    expect(res.flags.some((f) => f.flagType === "filler_loop" || f.flagType === "rapid_hallucination")).toBe(true);
    expect(res.verdict).not.toBe("good");
  });

  it("produces good verdict for clean audio segments", () => {
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
    expect(res.usableSpeechPercentage).toBe(100);
    expect(res.flags).toHaveLength(0);
  });
});
