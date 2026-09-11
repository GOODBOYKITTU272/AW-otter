import { describe, expect, it } from "vitest";
import {
  evaluateTranscriptionAgainstBenchmark,
  loadBenchmarkCase,
  validateBenchmarkCaseSchema,
} from "./runner";
import { join } from "node:path";
import type { TranscriptionResult } from "../src/types";

describe("Benchmark Runner Suite", () => {
  it("rejects invalid benchmark schema with malformed timestamps", () => {
    const invalidCase = {
      metadata: { id: "bad-1", audioFilename: "bad.wav" },
      groundTruthSegments: [
        { startMs: 5000, endMs: 2000, text: "invalid backwards timestamp" },
      ],
    };
    expect(() => validateBenchmarkCaseSchema(invalidCase)).toThrow(
      "Invalid benchmark segment: timestamps or text malformed."
    );
  });

  it("loads ground-truth fixture and evaluates exact match hypothesis to 0 WER and 0 CER", async () => {
    const fixturePath = join(__dirname, "fixtures/openslr-te-01.json");
    const testCase = await loadBenchmarkCase(fixturePath);

    expect(testCase.metadata.id).toBe("openslr-te-01");
    expect(testCase.groundTruthSegments).toHaveLength(1);

    const fullRefText = testCase.groundTruthSegments.map((s) => s.text).join(" ");
    const mockHypothesis: TranscriptionResult = {
      text: fullRefText,
      detectedLanguage: "en",
      durationSeconds: 45,
      segments: testCase.groundTruthSegments.map((s, idx) => ({
        index: idx,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        confidence: 0.95,
      })),
      words: null,
      model: "test-evaluator",
      usage: { seconds: 45, cost: 0 },
      providerMetadata: {},
    };

    const evaluation = evaluateTranscriptionAgainstBenchmark(
      testCase,
      mockHypothesis,
      "whisper-large-v3",
      1200
    );

    expect(evaluation.wer).toBe(0);
    expect(evaluation.cer).toBe(0);
    expect(evaluation.caseId).toBe("openslr-te-01");
    expect(evaluation.substitutions).toBe(0);
    expect(evaluation.deletions).toBe(0);
    expect(evaluation.insertions).toBe(0);
  });
});
