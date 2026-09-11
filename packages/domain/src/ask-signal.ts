import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import {
  hydrateVerifiedEvidence,
  type AskSignalProvider,
  type AskSignalResult,
  type EvidenceBundle,
  type EvidenceItem,
} from "@applywizz/ai";

export type { EvidenceBundle, EvidenceItem } from "@applywizz/ai";
export type AppSupabaseClient = SupabaseClient<Database>;

export class CustomerNotVisibleError extends Error {
  constructor() {
    super("Customer not found or not visible to the current user.");
    this.name = "CustomerNotVisibleError";
  }
}

const MAX_TRUTH_FACTS = 20;
const MAX_CALL_RECORDS = 20;
const MAX_BUNDLE_ITEMS = 40;

function truthFactLabel(fieldKey: string, status: string, detectedAt: string) {
  return `${fieldKey} (${status}, ${detectedAt.slice(0, 10)})`;
}

/**
 * M13 vertical slice retrieval (locked: docs/product/m13-plan.md §6, steps
 * 1-3 only). Every query is explicitly `.eq("customer_id", customerId)` —
 * defense in depth on top of RLS, never "fetch broadly then filter in app
 * code". `question` is accepted but unused in this slice — reserved for
 * the phase-2 full-text-search fallback (§6 step 6) when Ask Signal
 * expands to cross-meeting/transcript-content questions; kept in the
 * signature now so that expansion doesn't change this function's public
 * shape.
 */
export async function retrieveEvidenceBundle(
  supabase: AppSupabaseClient,
  customerId: string,
  _question: string,
): Promise<EvidenceBundle> {
  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, name")
    .eq("id", customerId)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer) {
    return { customerId, customerName: "", items: [] };
  }

  const { data: truthFacts, error: truthError } = await supabase
    .from("customer_truth_facts")
    .select(
      "id, field_key, value, status, source_meeting_id, evidence_segment_ids, detected_at",
    )
    .eq("customer_id", customerId)
    // Codex M13 Pass 2 SHOULD-FIX (fixed): "superseded" facts are real
    // ledger history (the prior value of something that later changed) —
    // dropping them breaks "what changed?" questions. "rejected" stays
    // excluded — a rejected proposal was never real customer state.
    .in("status", ["confirmed", "proposed", "superseded"])
    .order("detected_at", { ascending: false })
    .limit(MAX_TRUTH_FACTS);
  if (truthError) throw truthError;

  const { data: callRecords, error: callRecordsError } = await supabase
    .from("call_records")
    .select(
      "id, meeting_id, record_type, description, status, due_at, evidence_segment_ids",
    )
    .eq("customer_id", customerId)
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(MAX_CALL_RECORDS);
  if (callRecordsError) throw callRecordsError;

  const truthItems: EvidenceItem[] = (truthFacts ?? []).map((f) => ({
    type: "customer_truth_fact",
    id: f.id,
    meetingId: f.source_meeting_id,
    label: truthFactLabel(f.field_key, f.status, f.detected_at),
    text: `${f.field_key} = ${JSON.stringify(f.value)}`,
  }));

  const callRecordItems: EvidenceItem[] = (callRecords ?? []).map((r) => ({
    type: "call_record",
    id: r.id,
    meetingId: r.meeting_id,
    label: `${r.record_type} (${r.status})`,
    text: r.description,
  }));

  const segmentIds = Array.from(
    new Set(
      [...(truthFacts ?? []), ...(callRecords ?? [])].flatMap(
        (row) => row.evidence_segment_ids ?? [],
      ),
    ),
  );

  let transcriptItems: EvidenceItem[] = [];
  if (segmentIds.length > 0) {
    const { data: segments, error: segmentsError } = await supabase
      .from("transcript_segments")
      .select("id, transcript_id, start_ms, original_text, speaker_label")
      .in("id", segmentIds);
    if (segmentsError) throw segmentsError;

    // Codex M13 Pass 2 SHOULD-FIX (fixed): resolve each segment's real
    // meeting via its transcript, so a citation of ONLY a transcript
    // segment still populates meetingReferences (previously always null).
    const transcriptIds = Array.from(
      new Set((segments ?? []).map((s) => s.transcript_id)),
    );
    let meetingIdByTranscript = new Map<string, string>();
    if (transcriptIds.length > 0) {
      const { data: transcripts, error: transcriptsError } = await supabase
        .from("meeting_transcripts")
        .select("id, meeting_id")
        .in("id", transcriptIds);
      if (transcriptsError) throw transcriptsError;
      meetingIdByTranscript = new Map(
        (transcripts ?? []).map((t) => [t.id, t.meeting_id]),
      );
    }

    transcriptItems = (segments ?? []).map((s) => ({
      type: "transcript_segment",
      id: s.id,
      meetingId: meetingIdByTranscript.get(s.transcript_id) ?? null,
      label: `Transcript @ ${s.start_ms}ms`,
      text: `${s.speaker_label}: ${s.original_text}`,
    }));
  }

  // Bundle cap: truth facts and call records are always kept (small,
  // high-value); transcript segment items are trimmed first if the total
  // would exceed the cap, so a customer with a very long history can
  // never blow the prompt budget.
  const priorityItems = [...truthItems, ...callRecordItems];
  const remaining = Math.max(0, MAX_BUNDLE_ITEMS - priorityItems.length);
  const items = [...priorityItems, ...transcriptItems.slice(0, remaining)];

  return { customerId, customerName: customer.name, items };
}

function insufficientEvidenceResult(
  customerId: string,
  reason: string,
): AskSignalResult {
  return {
    answerability: "insufficient_evidence",
    answer: `I don't have enough evidence in Signal to answer that — ${reason}.`,
    evidence: [],
    customerReferences: [customerId],
    meetingReferences: [],
    unresolvedAmbiguity: null,
    followUpSuggestions: [],
  };
}

/**
 * M13 §5 orchestrator, called by the route with the CALLER's own
 * `supabase` client (RLS-respecting) — never a service-role client. No
 * tool-calling/agentic loop: retrieval happens entirely here, before the
 * model is ever invoked, scoped to one customer.
 */
export async function answerCustomerQuestion(
  supabase: AppSupabaseClient,
  provider: AskSignalProvider,
  customerId: string,
  question: string,
): Promise<AskSignalResult> {
  const bundle = await retrieveEvidenceBundle(supabase, customerId, question);
  if (bundle.items.length === 0) {
    return insufficientEvidenceResult(
      customerId,
      "this customer has no recorded truth facts or call activity yet",
    );
  }

  const { result: modelOutput } = await provider.respond({
    customerId,
    question,
    evidence: bundle.items,
  });

  const evidence = hydrateVerifiedEvidence(modelOutput.citedEvidence, bundle);

  // If hydration drops every cited item (e.g. the model invented ids),
  // never show an uncited/unverifiable answer — downgrade instead.
  const answerability =
    modelOutput.answerability !== "insufficient_evidence" &&
    evidence.length === 0
      ? "insufficient_evidence"
      : modelOutput.answerability;
  const answer =
    answerability === "insufficient_evidence" &&
    modelOutput.answerability !== "insufficient_evidence"
      ? "I don't have verifiable evidence to support an answer to that."
      : modelOutput.answer;

  const meetingReferences = Array.from(
    new Set(
      evidence
        .map((e) => e.meetingId)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const groundingStatus =
    answerability === "insufficient_evidence"
      ? ("insufficient_evidence" as const)
      : answerability === "partially_answered"
        ? ("partially_supported" as const)
        : ("supported" as const);

  return {
    answerability,
    answer,
    evidence,
    customerReferences: [customerId],
    meetingReferences,
    unresolvedAmbiguity:
      answerability === "insufficient_evidence" &&
      modelOutput.answerability !== "insufficient_evidence"
        ? null
        : modelOutput.unresolvedAmbiguity,
    followUpSuggestions:
      answerability === "insufficient_evidence" &&
      modelOutput.answerability !== "insufficient_evidence"
        ? []
        : modelOutput.followUpSuggestions,
    groundingStatus,
    integrityWarning: null,
    proposedFacts: [],
  };
}
