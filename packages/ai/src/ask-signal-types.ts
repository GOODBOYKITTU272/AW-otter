import { z } from "zod";

/**
 * M13 vertical slice (locked: docs/product/m13-plan.md §6-7). Evidence
 * types are intentionally a superset of what phase 1 retrieval actually
 * populates (customer_truth_fact / call_record / transcript_segment) —
 * meeting_summary and crm_baseline are reserved for the cross-meeting
 * expansion phase, not built here.
 */
export type EvidenceItemType =
  | "customer_truth_fact"
  | "call_record"
  | "meeting_summary"
  | "transcript_segment"
  | "crm_baseline";

export interface EvidenceItem {
  type: EvidenceItemType;
  id: string;
  meetingId: string | null;
  label: string;
  text: string;
}

export interface EvidenceBundle {
  customerId: string;
  customerName: string;
  items: EvidenceItem[];
}

// Model cites evidence by (type, id) ONLY — no `excerpt` field. The
// displayed excerpt is always re-hydrated server-side from the original
// EvidenceBundle (hydrateVerifiedEvidence below), never from model output.
// This makes a fabricated-excerpt attack on a real cited id structurally
// impossible rather than merely checked-for (Codex M13 Pass 1 BLOCKING #2).
export const askSignalCitedEvidenceSchema = z.object({
  type: z.enum([
    "customer_truth_fact",
    "call_record",
    "meeting_summary",
    "transcript_segment",
    "crm_baseline",
  ]),
  id: z.string().min(1),
});

export const askSignalModelOutputSchema = z
  .object({
    answerability: z.enum([
      "answered",
      "partially_answered",
      "insufficient_evidence",
    ]),
    answer: z.string().min(1),
    citedEvidence: z.array(askSignalCitedEvidenceSchema).default([]),
    unresolvedAmbiguity: z.string().nullable().default(null),
    followUpSuggestions: z.array(z.string()).max(4).default([]),
  })
  .superRefine((val, ctx) => {
    if (
      val.answerability !== "insufficient_evidence" &&
      val.citedEvidence.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "answered/partially_answered responses must cite at least one evidence item.",
        path: ["citedEvidence"],
      });
    }
  });
export type AskSignalModelOutput = z.infer<typeof askSignalModelOutputSchema>;

export interface AskSignalResult {
  answerability: "answered" | "partially_answered" | "insufficient_evidence";
  answer: string;
  evidence: EvidenceItem[];
  customerReferences: string[];
  meetingReferences: string[];
  unresolvedAmbiguity: string | null;
  followUpSuggestions: string[];
}

export interface AskSignalProviderResult {
  result: AskSignalModelOutput;
  model: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cost: number | null;
  };
}

export interface AskSignalInput {
  customerId: string;
  question: string;
  evidence: EvidenceItem[];
}

export interface AskSignalProvider {
  readonly name: string;
  respond(input: AskSignalInput): Promise<AskSignalProviderResult>;
}

/**
 * §7 citation-fabrication defense: any (type,id) the model invented (not
 * present in the bundle it was actually given) is silently dropped, never
 * surfaced, never guessed-at. Every SURVIVING item's displayed text is the
 * server's own original excerpt from `bundle`, never anything the model
 * wrote — there is no field on the model's own schema this could come
 * from instead.
 */
export function hydrateVerifiedEvidence(
  cited: Array<{ type: EvidenceItemType; id: string }>,
  bundle: EvidenceBundle,
): EvidenceItem[] {
  const byKey = new Map(bundle.items.map((i) => [`${i.type}:${i.id}`, i]));
  const seen = new Set<string>();
  const out: EvidenceItem[] = [];
  for (const c of cited) {
    const key = `${c.type}:${c.id}`;
    const item = byKey.get(key);
    if (item && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
