import { readFile } from "node:fs/promises";
import { computeWer, type WerScore } from "./metrics/wer";
import { computeCer, type CerScore } from "./metrics/cer";
import type { BenchmarkCase, BenchmarkEvaluationResult } from "./metrics/types";
import type { TranscriptionResult } from "../src/types";

export function validateBenchmarkCaseSchema(data: unknown): asserts data is BenchmarkCase {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid benchmark case: payload is not an object.");
  }
  const obj = data as Record<string, unknown>;
  if (!obj.metadata || typeof obj.metadata !== "object") {
    throw new Error("Invalid benchmark case: missing or malformed metadata.");
  }
  const meta = obj.metadata as Record<string, unknown>;
  if (typeof meta.id !== "string" || !meta.id.trim()) {
    throw new Error("Invalid benchmark case: metadata.id is required.");
  }
  if (typeof meta.audioFilename !== "string" || !meta.audioFilename.trim()) {
    throw new Error("Invalid benchmark case: metadata.audioFilename is required.");
  }
  if (!Array.isArray(obj.groundTruthSegments)) {
    throw new Error("Invalid benchmark case: groundTruthSegments must be an array.");
  }
  for (const seg of obj.groundTruthSegments) {
    if (
      typeof seg.startMs !== "number" ||
      typeof seg.endMs !== "number" ||
      seg.endMs < seg.startMs ||
      typeof seg.text !== "string"
    ) {
      throw new Error("Invalid benchmark segment: timestamps or text malformed.");
    }
  }
}

export async function loadBenchmarkCase(jsonPath: string): Promise<BenchmarkCase> {
  const content = await readFile(jsonPath, "utf-8");
  const parsed = JSON.parse(content);
  validateBenchmarkCaseSchema(parsed);
  return parsed;
}

export function evaluateTranscriptionAgainstBenchmark(
  benchmark: BenchmarkCase,
  hypothesis: TranscriptionResult,
  modelName: string,
  elapsedMs: number
): BenchmarkEvaluationResult {
  const referenceFullText = benchmark.groundTruthSegments.map((s) => s.text).join(" ");
  const hypothesisFullText = hypothesis.text;

  const werResult: WerScore = computeWer(referenceFullText, hypothesisFullText);
  const cerResult: CerScore = computeCer(referenceFullText, hypothesisFullText);

  // Compute timestamp boundaries
  const _totalRefDurationMs = benchmark.groundTruthSegments.reduce(
    (acc, seg) => acc + (seg.endMs - seg.startMs),
    0
  );

  return {
    caseId: benchmark.metadata.id,
    model: modelName,
    wer: werResult.wer,
    cer: cerResult.cer,
    substitutions: werResult.substitutions,
    deletions: werResult.deletions,
    insertions: werResult.insertions,
    referenceWordCount: werResult.refWordCount,
    hypothesisWordCount: werResult.hypWordCount,
    durationMs: elapsedMs,
  };
}
