import { describe, expect, it } from "vitest";
import { computeWer, normalizeTextForEvaluation } from "./wer";

describe("WER Evaluation Suite", () => {
  it("normalizes multilingual text preserving Indic scripts and stripping punctuation", () => {
    const raw = "Hello, world! నమస్కారం, మీరు బాగున్నారా? हाँ मैं ठीक हूँ.";
    const tokens = normalizeTextForEvaluation(raw);
    expect(tokens).toEqual([
      "hello",
      "world",
      "నమస్కారం",
      "మీరు",
      "బాగున్నారా",
      "हाँ",
      "मैं",
      "ठीक",
      "हूँ",
    ]);
  });

  it("handles empty reference and hypothesis cleanly", () => {
    expect(computeWer("", "").wer).toBe(0);
    expect(computeWer("", "hello world").wer).toBe(1);
    expect(computeWer("hello world", "").wer).toBe(1);
  });

  it("calculates 0 WER for identical transcripts", () => {
    const text = "We agreed on eighty thousand dollars base salary";
    const res = computeWer(text, text);
    expect(res.wer).toBe(0);
    expect(res.substitutions).toBe(0);
    expect(res.deletions).toBe(0);
    expect(res.insertions).toBe(0);
  });

  it("calculates exact substitutions, deletions, and insertions", () => {
    const ref = "the candidate wants remote in texas";
    const hyp = "the candidate needs remote in dallas texas today";
    // wants -> needs (1 sub)
    // + dallas (1 ins)
    // + today (1 ins)
    // total cost: 3 on 6 ref words -> WER = 0.5
    const res = computeWer(ref, hyp);
    expect(res.substitutions).toBe(1);
    expect(res.insertions).toBe(2);
    expect(res.deletions).toBe(0);
    expect(res.refWordCount).toBe(6);
    expect(res.wer).toBe(0.5);
  });

  it("evaluates Telugu code-switched phrases correctly", () => {
    const ref = "nenu resume update chesi friday pampistanu";
    const hyp = "nenu resume update chesi friday pampisthanu"; // slight phonetic difference
    const res = computeWer(ref, hyp);
    expect(res.substitutions).toBe(1);
    expect(res.refWordCount).toBe(6);
    expect(res.wer).toBeCloseTo(1 / 6, 4);
  });

  it("evaluates pure Hindi and pure Telugu script WER", () => {
    const refHi = "मुझे नौकरी चाहिए";
    const hypHi = "मुझे जॉब चाहिए"; // 1 substitution
    const resHi = computeWer(refHi, hypHi);
    expect(resHi.substitutions).toBe(1);
    expect(resHi.refWordCount).toBe(3);
    expect(resHi.wer).toBeCloseTo(1 / 3, 4);

    const refTe = "ఒక రోజుకు ఇరవై నాలుగు హవర్లుంటాయి";
    const hypTe = "ఒక రోజుకి ఇరవై నాలుగు గంటలుంటాయి"; // 2 substitutions
    const resTe = computeWer(refTe, hypTe);
    expect(resTe.substitutions).toBe(2);
    expect(resTe.refWordCount).toBe(5);
    expect(resTe.wer).toBe(0.4);
  });
});
