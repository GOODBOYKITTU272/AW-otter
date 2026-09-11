import { describe, expect, it } from "vitest";
import { computeCer, normalizeTextForCer } from "./cer";

describe("CER Evaluation Suite", () => {
  it("normalizes multilingual text preserving Indic scripts without whitespace", () => {
    const raw = "నమస్కారం! Hello.";
    const chars = normalizeTextForCer(raw);
    expect(chars.join("")).toBe("నమస్కారంhello");
  });

  it("calculates 0 CER for identical character sequences", () => {
    const text = "ఒక రోజుకు ఇరవై నాలుగు హవర్లుంటాయి";
    const res = computeCer(text, text);
    expect(res.cer).toBe(0);
    expect(res.substitutions).toBe(0);
    expect(res.deletions).toBe(0);
    expect(res.insertions).toBe(0);
  });

  it("handles empty reference and hypothesis correctly", () => {
    expect(computeCer("", "").cer).toBe(0);
    expect(computeCer("", "hello").cer).toBe(1);
    expect(computeCer("hello", "").cer).toBe(1);
  });

  it("measures character substitutions in Hindi text", () => {
    const ref = "नमस्ते";
    const hyp = "नमस्तेजी"; // 2 insertions ("ज", "ी")
    const res = computeCer(ref, hyp);
    expect(res.insertions).toBe(2);
    expect(res.deletions).toBe(0);
    expect(res.substitutions).toBe(0);
  });
});
