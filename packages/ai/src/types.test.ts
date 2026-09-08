import { describe, expect, it } from "vitest";
import { meetingIntelligenceResultSchema } from "./types";

const SEG = "11111111-1111-1111-1111-111111111111";

describe("meetingIntelligenceResultSchema", () => {
  it("accepts a minimal valid result with callTypeSpecific: null", () => {
    const parsed = meetingIntelligenceResultSchema.parse({
      summary: "Customer discussed Python backend roles.",
      callRecords: [],
      customerTruthDeltas: [],
      callTypeSpecific: null,
    });
    expect(parsed.summary).toBe("Customer discussed Python backend roles.");
  });

  it("rejects a missing summary", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      callRecords: [],
      customerTruthDeltas: [],
      callTypeSpecific: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string summary", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "",
      callTypeSpecific: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a call_record with no evidenceSegmentIds", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      callRecords: [
        {
          recordType: "action_item",
          description: "Follow up",
          ownerType: "am",
          evidenceSegmentIds: [],
        },
      ],
      callTypeSpecific: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a customer_truth_delta with no evidenceSegmentIds", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      customerTruthDeltas: [
        {
          fieldKey: "target_roles",
          proposedValue: "Python backend",
          confidence: 0.9,
          evidenceSegmentIds: [],
        },
      ],
      callTypeSpecific: null,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a discovery-shaped callTypeSpecific and discriminates correctly", () => {
    const parsed = meetingIntelligenceResultSchema.parse({
      summary: "Discovery call.",
      callTypeSpecific: {
        callType: "discovery",
        onboardingCompleteness: { complete: false, missingFields: ["visa"] },
        goals: [{ text: "Backend role", evidenceSegmentIds: [SEG] }],
      },
    });
    expect(parsed.callTypeSpecific?.callType).toBe("discovery");
  });

  it("rejects a callTypeSpecific whose fields don't match its callType tag", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      callTypeSpecific: {
        callType: "discovery",
        // renewal-only field, wrong shape for discovery
        renewalDecision: "renewed",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a call_type_specific claim (e.g. goals) with no evidenceSegmentIds", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      callTypeSpecific: {
        callType: "discovery",
        onboardingCompleteness: { complete: true, missingFields: [] },
        goals: [{ text: "Backend role", evidenceSegmentIds: [] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unrecognized callType tag", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      callTypeSpecific: { callType: "not_a_real_type" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid evidenceSegmentIds entry", () => {
    const result = meetingIntelligenceResultSchema.safeParse({
      summary: "x",
      callRecords: [
        {
          recordType: "decision",
          description: "Approved",
          ownerType: "am",
          evidenceSegmentIds: ["not-a-uuid"],
        },
      ],
      callTypeSpecific: null,
    });
    expect(result.success).toBe(false);
  });
});
