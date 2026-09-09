import { describe, expect, it } from "vitest";
import {
  askSignalModelOutputSchema,
  hydrateVerifiedEvidence,
  type EvidenceBundle,
} from "./ask-signal-types";

describe("askSignalModelOutputSchema", () => {
  it("accepts a valid 'answered' response with citedEvidence", () => {
    const result = askSignalModelOutputSchema.safeParse({
      answerability: "answered",
      answer: "x",
      citedEvidence: [{ type: "call_record", id: "cr-1" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an 'answered' response with empty citedEvidence", () => {
    const result = askSignalModelOutputSchema.safeParse({
      answerability: "answered",
      answer: "x",
      citedEvidence: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts 'insufficient_evidence' with empty citedEvidence", () => {
    const result = askSignalModelOutputSchema.safeParse({
      answerability: "insufficient_evidence",
      answer: "Not enough evidence.",
      citedEvidence: [],
    });
    expect(result.success).toBe(true);
  });

  it("has no excerpt/quote field anywhere in the citedEvidence item shape", () => {
    const result = askSignalModelOutputSchema.safeParse({
      answerability: "answered",
      answer: "x",
      citedEvidence: [
        { type: "call_record", id: "cr-1", excerpt: "fabricated quote" },
      ],
    });
    expect(result.success).toBe(true);
    // Zod strips unknown keys by default (non-strict object) — prove the
    // parsed value never carries the fabricated excerpt through.
    expect(result.data?.citedEvidence[0]).not.toHaveProperty("excerpt");
  });
});

describe("hydrateVerifiedEvidence", () => {
  const bundle: EvidenceBundle = {
    customerId: "cust-1",
    customerName: "Test Customer",
    items: [
      {
        type: "call_record",
        id: "cr-1",
        meetingId: "m-1",
        label: "commitment",
        text: "The real, server-fetched text.",
      },
    ],
  };

  it("hydrates a real cited (type,id) with the server's original bundle text", () => {
    const out = hydrateVerifiedEvidence(
      [{ type: "call_record", id: "cr-1" }],
      bundle,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("The real, server-fetched text.");
  });

  it("silently drops a cited id that is a real, valid-looking pair but was never in the bundle (id-membership check alone would have passed a fabricated excerpt attack)", () => {
    const out = hydrateVerifiedEvidence(
      [{ type: "call_record", id: "cr-does-not-exist" }],
      bundle,
    );
    expect(out).toEqual([]);
  });

  it("de-duplicates a citation repeated twice", () => {
    const out = hydrateVerifiedEvidence(
      [
        { type: "call_record", id: "cr-1" },
        { type: "call_record", id: "cr-1" },
      ],
      bundle,
    );
    expect(out).toHaveLength(1);
  });
});
