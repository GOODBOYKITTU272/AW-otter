import { z } from "zod";
import type { EvidenceItemType } from "./ask-signal-types";

export type GroundingStatus =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "conflicting"
  | "insufficient_evidence"
  | "needs_review";

export type SpeakerBusinessRole = "AM" | "CANDIDATE" | "OTHER" | "UNKNOWN";

export interface TemporaryQueryScope {
  speakerRoleFilter?: SpeakerBusinessRole | null;
  currentMeetingOnly?: boolean;
  excludeIntegrityFlagged?: boolean;
  rawDirective?: string | null;
}

export interface EchoEvidenceItem {
  type: EvidenceItemType;
  id: string;
  meetingId: string | null;
  transcriptId: string | null;
  segmentId: string | null;
  label: string;
  text: string;
  speakerRole: SpeakerBusinessRole;
  speakerName: string | null;
  startMs: number | null;
  endMs: number | null;
  needsReview: boolean;
  integrityFlags: string[];
}

export interface EchoFactProposal {
  fieldKey: string;
  proposedValue: unknown;
  sourceMeetingId: string;
  evidenceSegmentIds: string[];
  sourceSpeaker?: string | null;
  status: "proposed";
  groundingStatus: GroundingStatus;
}

export interface EchoQueryResult {
  answer: string;
  groundingStatus: GroundingStatus;
  evidence: EchoEvidenceItem[];
  appliedScope: TemporaryQueryScope;
  proposedFacts: EchoFactProposal[];
  historyRewriteBlocked: boolean;
  integrityWarning: string | null;
  unresolvedAmbiguity: string | null;
}

export const echoModelCitedEvidenceSchema = z.object({
  type: z.enum([
    "customer_truth_fact",
    "call_record",
    "meeting_summary",
    "transcript_segment",
    "crm_baseline",
  ]),
  id: z.string().min(1),
});

export const echoModelOutputSchema = z.object({
  answerability: z.enum([
    "answered",
    "partially_answered",
    "insufficient_evidence",
  ]),
  groundingStatus: z
    .enum([
      "supported",
      "partially_supported",
      "unsupported",
      "conflicting",
      "insufficient_evidence",
      "needs_review",
    ])
    .default("supported"),
  answer: z.string().min(1),
  citedEvidence: z.array(echoModelCitedEvidenceSchema).default([]),
  unresolvedAmbiguity: z.string().nullable().default(null),
  integrityWarning: z.string().nullable().default(null),
  proposedFacts: z
    .array(
      z.object({
        fieldKey: z.string().min(1),
        proposedValue: z.unknown(),
        evidenceSegmentIds: z.array(z.string()).default([]),
        sourceSpeaker: z.string().nullable().default(null),
      }),
    )
    .default([]),
});

export type EchoModelOutput = z.infer<typeof echoModelOutputSchema>;
