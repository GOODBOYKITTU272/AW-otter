import { z } from "zod";

/**
 * M9 structured intelligence contract (locked: docs/product/
 * Signal_Post_M6_Redesign_v2.md §8, corrected per "M9 CORRECTIONS" review —
 * summary is now a first-class validated field, not buried in arbitrary
 * JSON). Every claim-bearing array item is `{text, evidenceSegmentIds}`,
 * never a bare string — this is what makes "100% of claims carry evidence"
 * checkable rather than aspirational.
 */
export const evidencedClaimSchema = z.object({
  text: z.string().min(1),
  // Codex plan review (BLOCKING, fixed): must require at least one entry,
  // same as callRecordSchema/customerTruthDeltaSchema — a `.default([])`
  // here let call_type_specific claims (goals, constraints, etc.) pass
  // with zero evidence, violating "100% of claims carry evidence."
  evidenceSegmentIds: z.array(z.string().uuid()).min(1),
});
export type EvidencedClaim = z.infer<typeof evidencedClaimSchema>;

const claimList = () => z.array(evidencedClaimSchema).default([]);

export const callRecordSchema = z.object({
  recordType: z.enum([
    "action_item",
    "commitment",
    "decision",
    "question",
    "blocker",
  ]),
  description: z.string().min(1),
  ownerType: z.enum(["customer", "am", "resume_team", "applywizz", "other"]),
  ownerRef: z.string().nullable().default(null),
  dueAt: z.string().datetime().nullable().default(null),
  evidenceSegmentIds: z.array(z.string().uuid()).min(1),
});
export type CallRecordExtraction = z.infer<typeof callRecordSchema>;

export const customerTruthDeltaSchema = z.object({
  fieldKey: z.string().min(1),
  previousValue: z.unknown().nullable().default(null),
  proposedValue: z.unknown(),
  confidence: z.number().min(0).max(1),
  evidenceSegmentIds: z.array(z.string().uuid()).min(1),
});
export type CustomerTruthDeltaExtraction = z.infer<
  typeof customerTruthDeltaSchema
>;

const discoverySpecific = z.object({
  callType: z.literal("discovery"),
  onboardingCompleteness: z.object({
    complete: z.boolean(),
    missingFields: z.array(z.string()).default([]),
  }),
  goals: claimList(),
  constraints: claimList(),
  contradictionsWithOnboarding: z
    .array(
      z.object({
        fieldKey: z.string(),
        onboardingValue: z.unknown().nullable(),
        statedValue: z.unknown(),
        evidenceSegmentIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .default([]),
  newInformation: claimList(),
  resumeTeamNeeds: claimList(),
});

const resumeReviewSpecific = z.object({
  callType: z.literal("resume_review"),
  resumeChangesRequested: claimList(),
  resumeChangesAccepted: claimList(),
  resumeChangesRejected: claimList(),
  positioningChanges: claimList(),
  skillCorrections: claimList(),
  roleTargetingChanges: claimList(),
  approvalState: z.enum(["approved", "changes_requested", "pending"]),
});

const orientationSpecific = z.object({
  callType: z.literal("orientation"),
  initialExperienceSentiment: z.enum(["positive", "neutral", "negative"]),
  confusionPoints: claimList(),
  applicationQualityConcerns: claimList(),
  targetingComplaints: claimList(),
  immediateCorrectiveActions: claimList(),
});

const progressSpecific = z.object({
  callType: z.literal("progress"),
  applicationsSubmittedCount: z.number().int().nullable().default(null),
  responsesCount: z.number().int().nullable().default(null),
  screensCount: z.number().int().nullable().default(null),
  interviewsCount: z.number().int().nullable().default(null),
  working: claimList(),
  notWorking: claimList(),
  complaints: claimList(),
  strategyChanges: claimList(),
});

const renewalSpecific = z.object({
  callType: z.literal("renewal"),
  valueDelivered: claimList(),
  unresolvedProblems: claimList(),
  objections: claimList(),
  churnRiskEvidence: claimList(),
  renewalDecision: z.enum([
    "renewed",
    "not_renewed",
    "undecided",
    "pending_customer",
  ]),
  nextMonthStrategy: claimList(),
});

/** Discriminated on `callType` — an unrecognized/malformed shape fails validation outright, never silently coerced. */
export const callTypeSpecificSchema = z.discriminatedUnion("callType", [
  discoverySpecific,
  resumeReviewSpecific,
  orientationSpecific,
  progressSpecific,
  renewalSpecific,
]);
export type CallTypeSpecific = z.infer<typeof callTypeSpecificSchema>;

/**
 * The full validated M9 output. `summary` is required and non-empty —
 * corrected requirement: the meeting summary must not be buried inside
 * arbitrary/unvalidated JSON. `callTypeSpecific` is omitted (null) when the
 * meeting's call_type is unknown (needs_link) — generic call_records /
 * customer_truth_deltas extraction still runs regardless.
 */
export const meetingIntelligenceResultSchema = z.object({
  summary: z.string().min(1),
  callRecords: z.array(callRecordSchema).default([]),
  customerTruthDeltas: z.array(customerTruthDeltaSchema).default([]),
  callTypeSpecific: callTypeSpecificSchema.nullable().default(null),
});
export type MeetingIntelligenceResult = z.infer<
  typeof meetingIntelligenceResultSchema
>;

export interface MeetingIntelligenceUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
}

export interface MeetingIntelligenceProviderResult {
  result: MeetingIntelligenceResult;
  model: string;
  usage: MeetingIntelligenceUsage;
  /** Safe provider response metadata (model/finish_reason/etc) — never raw auth headers, never anything beyond what's already in `result`. */
  providerMetadata: Record<string, unknown>;
}

export interface MeetingIntelligenceInput {
  meetingId: string;
  /** null when the meeting is still needs_link — callTypeSpecific extraction is skipped by the provider in that case (contract-level: the provider still returns a valid result with callTypeSpecific: null). */
  callType:
    | "discovery"
    | "resume_review"
    | "orientation"
    | "progress"
    | "renewal"
    | "other_unknown"
    | null;
  /** Ordered transcript segments, canonical English text preferred (falls back to original for English-source segments, which are identical anyway per M8's contract). */
  segments: Array<{
    id: string;
    text: string;
    speakerLabel: string;
  }>;
  /** Prior unresolved call_records / confirmed Customer Truth, for continuity (carriedFromPriorRecordId). Empty for now — no caller populates this yet; the provider contract accepts it so M10/M12 can wire real continuity later without a contract change. */
  priorContext?: {
    openCallRecords: Array<{ id: string; description: string }>;
  };
}

/**
 * Provider-neutral M9 contract (locked architecture: "domain code must not
 * depend on OpenRouter types" — same shape as TranscriptionProvider).
 * `respond` is intentionally the only method — extraction is one shot per
 * run, no streaming/multi-turn needed for this contract.
 */
export interface MeetingIntelligenceProvider {
  readonly name: string;
  extract(
    input: MeetingIntelligenceInput,
  ): Promise<MeetingIntelligenceProviderResult>;
}
