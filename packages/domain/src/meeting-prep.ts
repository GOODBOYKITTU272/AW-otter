import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import type {
  CallTypeSpecific,
  MeetingIntelligenceResult,
} from "@applywizz/ai";
import {
  getEffectiveCustomerTruth,
  type EffectiveTruthField,
} from "./customer-context";
import { getJourneyContext } from "./meeting-recap";
import type { NormalizedCrmBaseline } from "@applywizz/crm";

export type AppSupabaseClient = SupabaseClient<Database>;

export interface PrepCallRecordSummary {
  id: string;
  recordType:
    "action_item" | "commitment" | "decision" | "question" | "blocker";
  description: string;
  dueAt: string | null;
  evidenceSegmentIds: string[];
}

/**
 * Snake_case, matching `transcript_segments`' own columns directly — the
 * same shape the pre-existing `EvidenceSegments` component
 * (`apps/web/components/customer-truth/evidence-segments.tsx`) already
 * expects on `/customers/:id` and `/actions`. Deliberately NOT
 * `meeting-recap.ts`'s camelCase `TranscriptSegmentData` (a different
 * shape for a different consumer, `MeetingRecap`) — reusing it here would
 * silently mismatch what `EvidenceSegments` actually reads.
 */
export interface PrepEvidenceSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  original_text: string;
  speaker_label: string;
}

export type PreviousMeetingPrep =
  | { status: "none" }
  | { status: "not_ready" }
  | {
      status: "ready";
      callType: string | null;
      scheduledAt: string;
      summary: string;
      keyActions: PrepCallRecordSummary[];
      blockers: PrepCallRecordSummary[];
      confirmedTruthChanges: Array<{ fieldKey: string; value: unknown }>;
      callTypeSpecific: CallTypeSpecific | null;
      transcriptSegments: PrepEvidenceSegment[];
    };

export interface MeetingPrepData {
  meetingId: string;
  customer: { id: string; name: string; lifecycleStage: string | null } | null;
  callType: string | null;
  scheduledAt: string;
  previousMeeting: PreviousMeetingPrep;
  openItems: PrepCallRecordSummary[];
  currentTruth: EffectiveTruthField[];
  pendingTruth: Array<{ id: string; fieldKey: string; value: unknown }>;
  recentChanges: Array<{
    fieldKey: string;
    value: unknown;
    confirmedAt: string;
  }>;
  journey: {
    previousCall: { callType: string; scheduledAt: string } | null;
    nextCall: { callType: string; scheduledAt: string } | null;
  };
  serviceEnd: string | null;
  recommendedFocus: string[];
}

/**
 * §6 (Codex Pass 1 SHOULD-FIX, fixed): the previous meeting for RECAP DATA
 * purposes is looked up via the canonical `meetings` table directly —
 * `customer_id` match + `scheduled_start` ordering — never via
 * `scheduler_calls`/`getJourneyContext` (which can be unmatched/absent for
 * a given meeting and would wrongly report "no previous meeting"
 * otherwise). `getJourneyContext` is still used below, but only for the
 * `journey` field's call-type-sequence labels — its original, narrower
 * M11 purpose.
 */
export async function getMeetingPrepData(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<MeetingPrepData | null> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, organization_id, customer_id, call_type, scheduled_start")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError) throw meetingError;
  if (!meeting) return null;

  const { data: customer, error: customerError } = meeting.customer_id
    ? await supabase
        .from("customers")
        .select("id, name, lifecycle_stage")
        .eq("id", meeting.customer_id)
        .maybeSingle()
    : { data: null, error: null };
  if (customerError) throw customerError;

  if (!meeting.customer_id || !customer) {
    return {
      meetingId: meeting.id,
      customer: null,
      callType: meeting.call_type,
      scheduledAt: meeting.scheduled_start,
      previousMeeting: { status: "none" },
      openItems: [],
      currentTruth: [],
      pendingTruth: [],
      recentChanges: [],
      journey: { previousCall: null, nextCall: null },
      serviceEnd: null,
      recommendedFocus: [],
    };
  }

  const { data: previousMeetingRow, error: prevMeetingError } = await supabase
    .from("meetings")
    .select("id, call_type, scheduled_start")
    .eq("customer_id", meeting.customer_id)
    .lt("scheduled_start", meeting.scheduled_start)
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevMeetingError) throw prevMeetingError;

  const previousMeeting = await buildPreviousMeetingPrep(
    supabase,
    previousMeetingRow,
  );

  const { data: openRecordRows, error: openRecordsError } = await supabase
    .from("call_records")
    .select("id, record_type, description, due_at, evidence_segment_ids")
    .eq("customer_id", meeting.customer_id)
    .eq("status", "detected")
    .order("due_at", { ascending: true, nullsFirst: false });
  if (openRecordsError) throw openRecordsError;
  const openItems: PrepCallRecordSummary[] = (openRecordRows ?? []).map(
    (r) => ({
      id: r.id,
      recordType: r.record_type,
      description: r.description,
      dueAt: r.due_at,
      evidenceSegmentIds: r.evidence_segment_ids ?? [],
    }),
  );

  const currentTruth = await getEffectiveCustomerTruth(
    supabase,
    meeting.customer_id,
  );

  const { data: pendingFacts, error: pendingError } = await supabase
    .from("customer_truth_facts")
    .select("id, field_key, value")
    .eq("customer_id", meeting.customer_id)
    .eq("status", "proposed");
  if (pendingError) throw pendingError;
  const pendingTruth = (pendingFacts ?? []).map((f) => ({
    id: f.id,
    fieldKey: f.field_key,
    value: f.value,
  }));

  const { data: recentFacts, error: recentError } = await supabase
    .from("customer_truth_facts")
    .select("field_key, value, confirmed_at")
    .eq("customer_id", meeting.customer_id)
    .eq("status", "confirmed")
    .order("confirmed_at", { ascending: false })
    .limit(5);
  if (recentError) throw recentError;
  const recentChanges = (recentFacts ?? [])
    .filter((f) => f.confirmed_at)
    .map((f) => ({
      fieldKey: f.field_key,
      value: f.value,
      confirmedAt: f.confirmed_at!,
    }));

  const { data: snapshot, error: snapshotError } = await supabase
    .from("customer_context_snapshots")
    .select("normalized_data")
    .eq("customer_id", meeting.customer_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshotError) throw snapshotError;
  const serviceEnd =
    (snapshot?.normalized_data as unknown as NormalizedCrmBaseline | null)
      ?.context?.service_end ?? null;

  const journey = await getJourneyContext(
    supabase,
    meeting.customer_id,
    meeting.id,
  );

  const recommendedFocus = deriveRecommendedFocus({
    openItems,
    pendingTruthCount: pendingTruth.length,
    previousMeeting,
  });

  return {
    meetingId: meeting.id,
    customer: {
      id: customer.id,
      name: customer.name,
      lifecycleStage: customer.lifecycle_stage,
    },
    callType: meeting.call_type,
    scheduledAt: meeting.scheduled_start,
    previousMeeting,
    openItems,
    currentTruth,
    pendingTruth,
    recentChanges,
    journey,
    serviceEnd,
    recommendedFocus,
  };
}

async function buildPreviousMeetingPrep(
  supabase: AppSupabaseClient,
  previousMeetingRow: {
    id: string;
    call_type: string | null;
    scheduled_start: string;
  } | null,
): Promise<PreviousMeetingPrep> {
  if (!previousMeetingRow) return { status: "none" };

  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select("id, processing_status")
    .eq("meeting_id", previousMeetingRow.id)
    .maybeSingle();
  if (transcriptError) throw transcriptError;
  if (!transcript || transcript.processing_status !== "completed") {
    return { status: "not_ready" };
  }

  const { data: aiRun, error: aiRunError } = await supabase
    .from("ai_runs")
    .select("summary, validated_output")
    .eq("meeting_id", previousMeetingRow.id)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (aiRunError) throw aiRunError;
  if (!aiRun) return { status: "not_ready" };

  const validatedOutput =
    aiRun.validated_output as unknown as MeetingIntelligenceResult;

  const { data: recordRows, error: recordsError } = await supabase
    .from("call_records")
    .select("id, record_type, description, due_at, evidence_segment_ids")
    .eq("meeting_id", previousMeetingRow.id)
    .order("created_at", { ascending: true });
  if (recordsError) throw recordsError;
  const records = (recordRows ?? []).map((r) => ({
    id: r.id,
    recordType: r.record_type,
    description: r.description,
    dueAt: r.due_at,
    evidenceSegmentIds: r.evidence_segment_ids ?? [],
  }));
  const keyActions = records.filter(
    (r) => r.recordType === "action_item" || r.recordType === "commitment",
  );
  const blockers = records.filter(
    (r) => r.recordType === "blocker" || r.recordType === "question",
  );

  const { data: confirmedFacts, error: confirmedError } = await supabase
    .from("customer_truth_facts")
    .select("field_key, value")
    .eq("source_meeting_id", previousMeetingRow.id)
    .eq("status", "confirmed");
  if (confirmedError) throw confirmedError;

  const { data: transcriptSegmentRows, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select("id, start_ms, end_ms, original_text, speaker_label")
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });
  if (segmentsError) throw segmentsError;
  const transcriptSegments: PrepEvidenceSegment[] = (
    transcriptSegmentRows ?? []
  ).map((s) => ({
    id: s.id,
    start_ms: s.start_ms,
    end_ms: s.end_ms,
    original_text: s.original_text,
    speaker_label: s.speaker_label,
  }));

  return {
    status: "ready",
    callType: previousMeetingRow.call_type,
    scheduledAt: previousMeetingRow.scheduled_start,
    summary: aiRun.summary ?? validatedOutput.summary,
    keyActions,
    blockers,
    confirmedTruthChanges: (confirmedFacts ?? []).map((f) => ({
      fieldKey: f.field_key,
      value: f.value,
    })),
    callTypeSpecific: validatedOutput.callTypeSpecific,
    transcriptSegments,
  };
}

/**
 * §"Meeting Objective" (Codex Pass 1 SHOULD-FIX, fixed): reads from an
 * explicit ALLOWLIST only — mirrors `deriveCustomerSafeRecap`'s select-
 * only-what-it-needs pattern from M11. Deliberately NEVER reads
 * `churnRiskEvidence`, `objections`, or `unresolvedProblems` — those are
 * real fields on the renewal `callTypeSpecific` shape
 * (`packages/ai/src/types.ts`) that the internal recap already renders
 * verbatim; letting them feed a "recommended focus" composer would turn
 * renewal risk evidence into a disguised risk signal, which is explicitly
 * forbidden. No AI call — deterministic composition only.
 */
function deriveRecommendedFocus(input: {
  openItems: PrepCallRecordSummary[];
  pendingTruthCount: number;
  previousMeeting: PreviousMeetingPrep;
}): string[] {
  const focus: string[] = [];
  const now = new Date().toISOString();

  const overdue = input.openItems.filter(
    (i) => i.recordType !== "blocker" && i.dueAt && i.dueAt < now,
  );
  if (overdue.length > 0) {
    focus.push(
      overdue.length === 1
        ? `Resolve overdue item: ${overdue[0]?.description}`
        : `Resolve ${overdue.length} overdue items`,
    );
  }

  const blockers = input.openItems.filter((i) => i.recordType === "blocker");
  if (blockers.length > 0) {
    focus.push(
      blockers.length === 1
        ? `Address blocker: ${blockers[0]?.description}`
        : `Address ${blockers.length} unresolved blockers`,
    );
  }

  if (input.pendingTruthCount > 0) {
    focus.push(
      `Confirm ${input.pendingTruthCount} pending customer truth change${input.pendingTruthCount === 1 ? "" : "s"}`,
    );
  }

  if (
    input.previousMeeting.status === "ready" &&
    input.previousMeeting.callTypeSpecific
  ) {
    const specific = input.previousMeeting.callTypeSpecific;
    switch (specific.callType) {
      case "discovery":
        if (
          !specific.onboardingCompleteness.complete &&
          specific.onboardingCompleteness.missingFields.length > 0
        ) {
          focus.push(
            `Fill remaining onboarding gaps: ${specific.onboardingCompleteness.missingFields.join(", ")}`,
          );
        }
        break;
      case "resume_review":
        if (
          specific.resumeChangesRequested.length > 0 &&
          specific.approvalState !== "approved"
        ) {
          focus.push("Confirm requested resume changes were completed");
        }
        break;
      case "orientation":
        if (specific.confusionPoints.length > 0)
          focus.push("Clarify prior confusion points");
        if (specific.immediateCorrectiveActions.length > 0)
          focus.push("Follow up on immediate corrective actions");
        break;
      case "progress":
        if (specific.strategyChanges.length > 0)
          focus.push("Review whether the last strategy change is working");
        break;
      case "renewal":
        if (specific.nextMonthStrategy.length > 0)
          focus.push("Revisit next-period strategy discussed last time");
        break;
    }
  }

  return focus;
}
