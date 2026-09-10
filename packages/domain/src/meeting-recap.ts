import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import type {
  CallTypeSpecific,
  MeetingIntelligenceResult,
} from "@applywizz/ai";
import { logAuditEvent } from "./audit";
import {
  analyzeMeetingIntegrity,
  type MeetingIntegrityAnalysis,
  type MeetingIntegrityFlag,
  type IntegrityVerdict,
} from "./meeting-integrity";
import {
  getEffectiveCustomerTruth,
  isSemanticallySameValue,
} from "./customer-context";

export type AppSupabaseClient = SupabaseClient<Database>;

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other / Unknown",
};

export interface TranscriptSegmentData {
  id: string;
  startMs: number;
  endMs: number;
  speakerLabel: string;
  originalText: string;
  canonicalEnglishText: string;
}

export interface CallRecordRecapItem {
  /** null only for fixture-preview data — every real row has a real id. */
  id?: string;
  recordType:
    "action_item" | "commitment" | "decision" | "question" | "blocker";
  description: string;
  ownerType: "customer" | "am" | "resume_team" | "applywizz" | "other";
  ownerRef: string | null;
  dueAt: string | null;
  /** call_records.status — undefined for fixture-preview data. */
  status?: string;
  evidenceSegmentIds: string[];
}

export interface CustomerTruthDeltaRecapItem {
  id?: string;
  fieldKey: string;
  previousValue: unknown;
  proposedValue: unknown;
  confidence: number;
  /** customer_truth_facts.status — undefined for fixture-preview data. */
  status?: string;
  /** true when a still-proposed delta's value already matches effective current truth — same deterministic comparison /customers/:id uses, no second AI call. */
  noChange?: boolean;
  evidenceSegmentIds: string[];
}

export interface CustomerSafeRecap {
  id?: string;
  status?: "draft" | "ready_for_review" | "approved";
  greeting: string;
  agreements?: string[];
  actions?: string[];
  nextStep: string;
  whatWeAgreed?: string[];
  applyWizzWillDo?: string[];
  customerShouldDo?: string[];
  approvedAt?: string | null;
  approvedByMembershipId?: string | null;
  currentRevisionNumber?: number;
  revisionReason?: string | null;
}

export interface MeetingRecapData {
  id: string;
  organizationId?: string;
  customer: {
    id?: string | null;
    name: string;
    lifecycleStage: string;
    ownerName: string;
  };
  meetingDate: string;
  nextJourneyStep: string;
  transcriptSegments: TranscriptSegmentData[];
  recordingUrl?: string | null;
  integrityReport?: MeetingIntegrityAnalysis | null;
  result: {
    summary: string;
    callRecords: CallRecordRecapItem[];
    customerTruthDeltas: CustomerTruthDeltaRecapItem[];
    callTypeSpecific: CallTypeSpecific | null;
  };
  /** Undefined for fixture-preview data — real data always sets it (null only when the meeting has no linked customer). */
  customerSafeRecap?: CustomerSafeRecap | null;
}

export type MeetingRecapState =
  | { status: "ready"; recap: MeetingRecapData }
  | { status: "transcript_processing" }
  | { status: "transcript_failed"; errorCode: string | null }
  | { status: "intelligence_not_ready" }
  | { status: "intelligence_failed"; errorCode: string | null };

/**
 * M11: converts the fixture-driven recap prep into a real read, reusing
 * M8 transcripts / M9 ai_runs+call_records+customer_truth_facts / M10
 * effective-truth precedence. Returns null when the meeting itself isn't
 * visible to the caller (RLS) — the route calls notFound() in that case.
 * All other "not ready yet" cases are real, distinguishable states, never
 * a silent blank page.
 */
export async function getMeetingRecapData(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<MeetingRecapState | null> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select(
      "id, organization_id, title, customer_id, call_type, scheduled_start, actual_start, owner_membership_id",
    )
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError) throw meetingError;
  if (!meeting) return null;

  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select("id, processing_status, error_code")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (transcriptError) throw transcriptError;

  if (!transcript || transcript.processing_status !== "completed") {
    if (transcript?.processing_status === "failed") {
      return { status: "transcript_failed", errorCode: transcript.error_code };
    }
    return { status: "transcript_processing" };
  }

  // Codex Pass 2 (SHOULD-FIX, fixed): a plain "newest ai_runs row" query
  // would reject a perfectly good earlier completed run just because a
  // later reprocessing attempt (different model/prompt_version — a
  // genuinely different identity per ai_runs_identity_uq, M9's design)
  // failed or is still running. Always prefer the latest COMPLETED run;
  // only fall back to the latest run overall to report a real not-ready/
  // failed state when no completed run exists at all.
  const { data: completedRun, error: completedRunError } = await supabase
    .from("ai_runs")
    .select("id, status, summary, validated_output, error_code")
    .eq("meeting_id", meetingId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (completedRunError) throw completedRunError;

  let aiRun = completedRun;
  if (!aiRun) {
    const { data: latestRun, error: latestRunError } = await supabase
      .from("ai_runs")
      .select("id, status, summary, validated_output, error_code")
      .eq("meeting_id", meetingId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestRunError) throw latestRunError;
    aiRun = latestRun;
  }

  if (!aiRun || aiRun.status !== "completed") {
    if (aiRun?.status === "failed") {
      return { status: "intelligence_failed", errorCode: aiRun.error_code };
    }
    return { status: "intelligence_not_ready" };
  }

  const validatedOutput =
    aiRun.validated_output as unknown as MeetingIntelligenceResult;

  const { data: segmentRows, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select(
      "id, start_ms, end_ms, original_text, canonical_english_text, speaker_label",
    )
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });
  if (segmentsError) throw segmentsError;
  const transcriptSegments: TranscriptSegmentData[] = (segmentRows ?? []).map(
    (s) => ({
      id: s.id,
      startMs: s.start_ms,
      endMs: s.end_ms,
      speakerLabel: s.speaker_label,
      originalText: s.original_text,
      canonicalEnglishText: s.canonical_english_text ?? s.original_text,
    }),
  );

  const { data: customer, error: customerError } = meeting.customer_id
    ? await supabase
        .from("customers")
        .select("id, name, lifecycle_stage, owner_membership_id")
        .eq("id", meeting.customer_id)
        .maybeSingle()
    : { data: null, error: null };
  if (customerError) throw customerError;

  const ownerMembershipId = customer?.owner_membership_id ?? null;
  const { data: ownerMembership, error: ownerError } = ownerMembershipId
    ? await supabase
        .from("organization_memberships")
        .select("display_name")
        .eq("id", ownerMembershipId)
        .maybeSingle()
    : { data: null, error: null };
  if (ownerError) throw ownerError;

  const { data: callRecordRows, error: callRecordsError } = await supabase
    .from("call_records")
    .select(
      "id, record_type, description, owner_type, owner_membership_id, external_owner_name, due_at, status, evidence_segment_ids",
    )
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: true });
  if (callRecordsError) throw callRecordsError;

  const recordOwnerMembershipIds = Array.from(
    new Set(
      (callRecordRows ?? [])
        .map((r) => r.owner_membership_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const memberNameById = new Map<string, string>();
  if (recordOwnerMembershipIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .from("organization_memberships")
      .select("id, display_name")
      .in("id", recordOwnerMembershipIds);
    if (membersError) throw membersError;
    for (const m of members ?? []) memberNameById.set(m.id, m.display_name);
  }

  const callRecords: CallRecordRecapItem[] = (callRecordRows ?? []).map(
    (r) => ({
      id: r.id,
      recordType: r.record_type,
      description: r.description,
      ownerType: r.owner_type,
      ownerRef: r.owner_membership_id
        ? (memberNameById.get(r.owner_membership_id) ?? null)
        : (r.external_owner_name ?? null),
      dueAt: r.due_at,
      status: r.status,
      evidenceSegmentIds: r.evidence_segment_ids ?? [],
    }),
  );

  const customerTruthDeltas = meeting.customer_id
    ? await buildCustomerTruthDeltas(
        supabase,
        meeting.customer_id,
        meetingId,
        validatedOutput,
      )
    : [];

  const journey = meeting.customer_id
    ? await getJourneyContext(supabase, meeting.customer_id, meetingId)
    : { previousCall: null, nextCall: null };

  const meetingDate = meeting.actual_start ?? meeting.scheduled_start;

  // 1. Customer-safe recap (persisted in meeting_recaps or derived)
  let customerSafeRecap: CustomerSafeRecap | null = null;
  const { data: savedRecapRow } = await supabase
    .from("meeting_recaps")
    .select("id, status, approved_at, approved_by_membership_id")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (savedRecapRow) {
    const { data: latestRev } = await supabase
      .from("meeting_recap_revisions")
      .select("*")
      .eq("recap_id", savedRecapRow.id)
      .order("revision_number", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestRev) {
      const agreements = (latestRev.agreements as string[]) ?? [];
      const actions = (latestRev.actions as string[]) ?? [];
      customerSafeRecap = {
        id: savedRecapRow.id,
        status: savedRecapRow.status as CustomerSafeRecap["status"],
        greeting: latestRev.greeting,
        agreements,
        actions,
        whatWeAgreed: agreements,
        applyWizzWillDo: actions,
        customerShouldDo: [],
        nextStep: latestRev.next_step,
        approvedAt: savedRecapRow.approved_at,
        approvedByMembershipId: savedRecapRow.approved_by_membership_id,
        currentRevisionNumber: latestRev.revision_number,
        revisionReason: latestRev.revision_reason,
      };
    }
  }

  if (!customerSafeRecap && customer) {
    customerSafeRecap = deriveCustomerSafeRecap({
      customerName: customer.name,
      callType: meeting.call_type,
      meetingDate,
      callRecords,
      nextJourneyStep: formatJourneyStep(journey),
    });
  }

  // 2. Meeting integrity report
  let integrityReport: MeetingIntegrityAnalysis | null = null;
  const { data: savedIntegrityRow } = await supabase
    .from("meeting_integrity_reports")
    .select("id, overall_verdict, summary, metrics")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (savedIntegrityRow) {
    const { data: flagRows } = await supabase
      .from("meeting_integrity_flags")
      .select("*")
      .eq("report_id", savedIntegrityRow.id)
      .order("start_ms", { ascending: true });

    const metrics = (savedIntegrityRow.metrics as Record<string, unknown>) ?? {};
    integrityReport = {
      verdict: savedIntegrityRow.overall_verdict as IntegrityVerdict,
      summary: savedIntegrityRow.summary,
      usableSpeechPercentage: Number(metrics.usableSpeechPercentage ?? 100),
      confidenceScoreAvg: Number(metrics.confidenceScoreAvg ?? 0.85),
      backgroundMediaDetected: Boolean(metrics.backgroundMediaDetected),
      flags: (flagRows ?? []).map((f) => ({
        id: f.id,
        flagType: f.flag_type as MeetingIntegrityFlag["flagType"],
        severity: f.severity as MeetingIntegrityFlag["severity"],
        startMs: f.start_ms,
        endMs: f.end_ms,
        reasonCode: f.reason_code,
        message: f.message,
        detectorVersion: f.detector_version,
      })),
      metrics: {
        usableSpeechPercentage: Number(metrics.usableSpeechPercentage ?? 100),
        confidenceScoreAvg: Number(metrics.confidenceScoreAvg ?? 0.85),
        backgroundMediaDetected: Boolean(metrics.backgroundMediaDetected),
        totalSpeechMs: Number(metrics.totalSpeechMs ?? 0),
        totalDurationSeconds: metrics.totalDurationSeconds as number | undefined,
        flagCount: flagRows?.length ?? 0,
      },
    };
  } else if (transcriptSegments.length > 0) {
    integrityReport = analyzeMeetingIntegrity({
      segments: transcriptSegments.map((s) => ({
        id: s.id,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.canonicalEnglishText,
      })),
    });
  }

  // 3. Audio recording URL
  let recordingUrl: string | null = null;
  const { data: recRow } = await supabase
    .from("meeting_recordings")
    .select("storage_bucket, storage_path")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (recRow && supabase.storage?.from) {
    try {
      const { data: signed } = await supabase.storage
        .from(recRow.storage_bucket)
        .createSignedUrl(recRow.storage_path, 3600);
      recordingUrl = signed?.signedUrl ?? null;
    } catch {
      // storage signed url is best effort
    }
  }

  const recap: MeetingRecapData = {
    id: meeting.id,
    organizationId: meeting.organization_id,
    customer: {
      id: meeting.customer_id,
      name: customer?.name ?? "Unlinked meeting",
      lifecycleStage: customer?.lifecycle_stage ?? "Lifecycle stage unknown",
      ownerName: ownerMembership?.display_name ?? "Unassigned",
    },
    meetingDate,
    nextJourneyStep: formatJourneyStep(journey),
    transcriptSegments,
    recordingUrl,
    integrityReport,
    result: {
      summary: aiRun.summary ?? validatedOutput.summary,
      callRecords,
      customerTruthDeltas,
      callTypeSpecific: validatedOutput.callTypeSpecific,
    },
    customerSafeRecap,
  };

  return { status: "ready", recap };
}

async function buildCustomerTruthDeltas(
  supabase: AppSupabaseClient,
  customerId: string,
  meetingId: string,
  validatedOutput: MeetingIntelligenceResult,
): Promise<CustomerTruthDeltaRecapItem[]> {
  const { data: factRows, error: factsError } = await supabase
    .from("customer_truth_facts")
    .select(
      "id, field_key, value, status, previous_fact_id, evidence_segment_ids",
    )
    .eq("source_meeting_id", meetingId)
    .order("detected_at", { ascending: true });
  if (factsError) throw factsError;
  const facts = factRows ?? [];
  if (facts.length === 0) return [];

  const confidenceByFieldKey = new Map(
    validatedOutput.customerTruthDeltas.map((d) => [d.fieldKey, d.confidence]),
  );

  const previousFactIds = Array.from(
    new Set(
      facts
        .map((f) => f.previous_fact_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const previousValueById = new Map<string, unknown>();
  if (previousFactIds.length > 0) {
    const { data: previousFacts, error: previousError } = await supabase
      .from("customer_truth_facts")
      .select("id, value")
      .in("id", previousFactIds);
    if (previousError) throw previousError;
    for (const pf of previousFacts ?? [])
      previousValueById.set(pf.id, pf.value);
  }

  // Fetched for proposed OR rejected facts that have no previous_fact_id —
  // for those two statuses this fact never became (and, for rejected,
  // never will become) the source of current truth, so "effective current
  // truth right now" is a safe stand-in for "the value this proposal would
  // have changed." Deliberately NOT used for confirmed/superseded facts:
  // effective current truth may already equal (confirmed) or have moved
  // past (superseded) this exact fact's own value, which would show a
  // fact's own value — or whatever superseded it — backwards as its own
  // "previous."
  const needsEffectiveLookup = facts.some(
    (f) =>
      (f.status === "proposed" || f.status === "rejected") &&
      !f.previous_fact_id,
  );
  let effectiveCurrentByField = new Map<string, unknown>();
  if (needsEffectiveLookup) {
    const [effective, current] = await Promise.all([
      getEffectiveCustomerTruth(supabase, customerId),
      supabase
        .from("customer_truth_current")
        .select("field_key, value")
        .eq("customer_id", customerId),
    ]);
    if (current.error) throw current.error;
    effectiveCurrentByField = new Map(
      (current.data ?? []).map((row) => [row.field_key as string, row.value]),
    );
    for (const f of effective) {
      if (f.provenance !== "none")
        effectiveCurrentByField.set(f.fieldKey, f.currentValue);
    }
  }

  return facts.map((f) => {
    const previousValue = f.previous_fact_id
      ? (previousValueById.get(f.previous_fact_id) ?? null)
      : f.status === "proposed" || f.status === "rejected"
        ? (effectiveCurrentByField.get(f.field_key) ?? null)
        : null;
    return {
      id: f.id,
      fieldKey: f.field_key,
      previousValue,
      proposedValue: f.value,
      confidence: confidenceByFieldKey.get(f.field_key) ?? 0,
      status: f.status,
      noChange:
        f.status === "proposed" &&
        isSemanticallySameValue(previousValue, f.value),
      evidenceSegmentIds: f.evidence_segment_ids ?? [],
    };
  });
}

interface JourneyCall {
  callType: string;
  scheduledAt: string;
}

interface JourneyContext {
  previousCall: JourneyCall | null;
  nextCall: JourneyCall | null;
}

/**
 * §8: previous/current/next call in this customer's journey, drawn purely
 * from real scheduler_calls rows for this customer — never a fabricated
 * fixed 5-stage sequence, and never a customer's meeting the caller isn't
 * otherwise authorized to see (RLS, including the new
 * scheduler_calls_select_manager_scope policy, does that).
 */
export async function getJourneyContext(
  supabase: AppSupabaseClient,
  customerId: string,
  currentMeetingId: string,
): Promise<JourneyContext> {
  const { data, error } = await supabase
    .from("scheduler_calls")
    .select("canonical_call_type, scheduled_at, meeting_id, external_status")
    .eq("customer_id", customerId)
    .order("scheduled_at", { ascending: true });
  if (error) throw error;
  const rows = data ?? [];
  const now = Date.now();

  // Codex Pass 2 (SHOULD-FIX, fixed): the previous version located
  // "previous"/"next" purely by position around currentMeetingId's index —
  // if the current meeting isn't itself linked from a scheduler_calls row
  // (e.g. manually linked, or the matcher hasn't run), currentIndex is -1
  // and "before current" silently became "every row," which could surface
  // a future call as the "previous" one. Both loops are now independent of
  // position: "previous" is the latest OTHER row with a real meeting_id
  // whose scheduled_at is actually in the past; "next" is the earliest OTHER
  // row that's actually still in the future and still SCHEDULED. Neither
  // can ever select the current meeting's own row.
  let previousCall: JourneyCall | null = null;
  for (const r of [...rows].reverse()) {
    if (
      r.meeting_id &&
      r.meeting_id !== currentMeetingId &&
      new Date(r.scheduled_at).getTime() < now
    ) {
      previousCall = {
        callType: r.canonical_call_type,
        scheduledAt: r.scheduled_at,
      };
      break;
    }
  }

  let nextCall: JourneyCall | null = null;
  for (const r of rows) {
    if (
      r.meeting_id !== currentMeetingId &&
      new Date(r.scheduled_at).getTime() > now &&
      r.external_status === "SCHEDULED"
    ) {
      nextCall = {
        callType: r.canonical_call_type,
        scheduledAt: r.scheduled_at,
      };
      break;
    }
  }

  return { previousCall, nextCall };
}

function formatJourneyStep(journey: JourneyContext): string {
  const label = (t: string) => CALL_TYPE_LABEL[t] ?? t;
  if (journey.nextCall) {
    const when = new Date(journey.nextCall.scheduledAt).toLocaleDateString(
      undefined,
      { month: "short", day: "numeric" },
    );
    return `Next: ${label(journey.nextCall.callType)} scheduled ${when}.`;
  }
  return "No next call scheduled yet.";
}

/**
 * §9: deterministic, template-based — no second AI call, no new pipeline.
 * Reads ONLY description/recordType/ownerType off the records passed in
 * (never the raw internal summary, never callTypeSpecific, never
 * blocker/question/decision record types) — a select-only-what-it-needs
 * function structurally cannot leak a column it never reads, per Codex
 * Pass 1's SHOULD-FIX (an exclusion list could miss a future internal-only
 * field; this can't, since it never reads the record in the first place).
 */
export function deriveCustomerSafeRecap(input: {
  customerName: string;
  callType: string | null;
  meetingDate: string;
  callRecords: Array<{
    recordType: string;
    description: string;
    ownerType: string;
  }>;
  nextJourneyStep: string;
}): CustomerSafeRecap {
  const callTypeLabel = input.callType ? CALL_TYPE_LABEL[input.callType] : null;
  const when = new Date(input.meetingDate).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });

  const whatWeAgreed = input.callRecords
    .filter((r) => r.recordType === "commitment")
    .map((r) => r.description);
  const applyWizzWillDo = input.callRecords
    .filter(
      (r) => r.recordType === "action_item" && r.ownerType === "applywizz",
    )
    .map((r) => r.description);
  const customerShouldDo = input.callRecords
    .filter(
      (r) => r.recordType === "action_item" && r.ownerType === "customer",
    )
    .map((r) => r.description);

  return {
    status: "draft",
    greeting: callTypeLabel
      ? `Thanks for the ${callTypeLabel.toLowerCase()} call on ${when}, ${input.customerName}.`
      : `Thanks for the call on ${when}, ${input.customerName}.`,
    agreements: whatWeAgreed,
    actions: [...applyWizzWillDo, ...customerShouldDo],
    whatWeAgreed,
    applyWizzWillDo,
    customerShouldDo,
    nextStep: input.nextJourneyStep,
  };
}

export interface RecentMeetingSummary {
  meetingId: string;
  customerId: string | null;
  customerName: string | null;
  callType: string | null;
  scheduledStart: string;
  summary: string | null;
  truthChangeCount: number;
  openActionCount: number;
}

/**
 * §11: shared query builder backing both /home's "recent conversations"
 * and /customers/:id's "recent meetings" — one function, two callers, per
 * the plan's "reuse it" decision. A fixed handful of batched queries
 * (never per-row), same batching idiom already used throughout this
 * codebase (evidence/membership lookups on /customers/:id, /actions).
 */
export async function listRecentMeetingSummaries(
  supabase: AppSupabaseClient,
  opts: { customerId?: string; limit?: number },
): Promise<RecentMeetingSummary[]> {
  const limit = opts.limit ?? 10;

  // Codex Pass 2 (SHOULD-FIX, fixed) + Codex Pass 3 (BLOCKING, fixed): the
  // previous `limit * 3` over-fetch was a heuristic that could hide older
  // ready conversations behind a run of newer not-yet-processed meetings.
  // The candidate meeting pool below is NOT truncated to anywhere near
  // `limit` — for a single customer (opts.customerId set) it's every
  // meeting they've ever had, a naturally small set; for a whole AM
  // portfolio it's capped at a generous fixed constant decoupled from
  // `limit`, not a multiple of it.
  //
  // Pass 3 caught a real regression in the first fix attempt: selecting
  // and truncating `readyMeetingIds` by `ai_runs.completed_at desc` (instead
  // of by the meeting's own `scheduled_start`) meant an OLD meeting that
  // happened to get reprocessed recently could displace a genuinely more
  // recent meeting from the list, and the final list's order no longer
  // matched "most recently held conversation first." Fixed by determining
  // the FULL ready-set from ai_runs (no early truncation there — the
  // in(meetingIds) filter already bounds it to the candidate pool), then
  // filtering+slicing the `meetings` list itself (already ordered by
  // scheduled_start desc) — the truncation dimension and the display
  // order are now the same one, scheduled_start.
  const CANDIDATE_POOL_CAP = 200;
  let meetingsQuery = supabase
    .from("meetings")
    .select("id, customer_id, call_type, scheduled_start")
    .order("scheduled_start", { ascending: false });
  meetingsQuery = opts.customerId
    ? meetingsQuery.eq("customer_id", opts.customerId)
    : meetingsQuery.limit(CANDIDATE_POOL_CAP);
  const { data: meetingRows, error: meetingsError } = await meetingsQuery;
  if (meetingsError) throw meetingsError;
  const meetings = meetingRows ?? [];
  if (meetings.length === 0) return [];

  const meetingIds = meetings.map((m) => m.id);

  const { data: runRows, error: runsError } = await supabase
    .from("ai_runs")
    .select("meeting_id, summary, status, completed_at")
    .in("meeting_id", meetingIds)
    .eq("status", "completed")
    .order("completed_at", { ascending: false });
  if (runsError) throw runsError;
  const summaryByMeeting = new Map<string, string | null>();
  for (const run of runRows ?? []) {
    if (!summaryByMeeting.has(run.meeting_id)) {
      summaryByMeeting.set(run.meeting_id, run.summary);
    }
  }

  const readyMeetings = meetings
    .filter((m) => summaryByMeeting.has(m.id))
    .slice(0, limit);
  if (readyMeetings.length === 0) return [];
  const readyMeetingIds = readyMeetings.map((m) => m.id);

  const [callRecordRows, truthFactRows, customerRows] = await Promise.all([
    supabase
      .from("call_records")
      .select("meeting_id")
      .in("meeting_id", readyMeetingIds)
      .eq("status", "detected"),
    supabase
      .from("customer_truth_facts")
      .select("source_meeting_id")
      .in("source_meeting_id", readyMeetingIds),
    supabase
      .from("customers")
      .select("id, name")
      .in(
        "id",
        Array.from(
          new Set(
            readyMeetings
              .map((m) => m.customer_id)
              .filter((v): v is string => Boolean(v)),
          ),
        ),
      ),
  ]);
  if (callRecordRows.error) throw callRecordRows.error;
  if (truthFactRows.error) throw truthFactRows.error;
  if (customerRows.error) throw customerRows.error;

  const actionCountByMeeting = new Map<string, number>();
  for (const r of callRecordRows.data ?? []) {
    actionCountByMeeting.set(
      r.meeting_id,
      (actionCountByMeeting.get(r.meeting_id) ?? 0) + 1,
    );
  }
  const truthCountByMeeting = new Map<string, number>();
  for (const f of truthFactRows.data ?? []) {
    if (!f.source_meeting_id) continue;
    truthCountByMeeting.set(
      f.source_meeting_id,
      (truthCountByMeeting.get(f.source_meeting_id) ?? 0) + 1,
    );
  }
  const customerNameById = new Map(
    (customerRows.data ?? []).map((c) => [c.id, c.name]),
  );

  return readyMeetings.map((m) => ({
    meetingId: m.id,
    customerId: m.customer_id,
    customerName: m.customer_id
      ? (customerNameById.get(m.customer_id) ?? null)
      : null,
    callType: m.call_type,
    scheduledStart: m.scheduled_start,
    summary: summaryByMeeting.get(m.id) ?? null,
    truthChangeCount: truthCountByMeeting.get(m.id) ?? 0,
    openActionCount: actionCountByMeeting.get(m.id) ?? 0,
  }));
}

export interface SaveMeetingRecapInput {
  meetingId: string;
  greeting: string;
  agreements?: string[];
  actions?: string[];
  nextStep: string;
  whatWeAgreed?: string[];
  applyWizzWillDo?: string[];
  customerShouldDo?: string[];
  candidateShouldDo?: string[];
  actorMembershipId?: string | null;
  status?: "draft" | "ready_for_review";
  reason?: string;
}

/**
 * Saves or updates an in-progress candidate-safe recap draft in meeting_recaps
 * and appends a new snapshot revision into meeting_recap_revisions.
 * Ensures AM edits persist safely without external delivery.
 */
export async function saveMeetingRecapDraft(
  supabase: AppSupabaseClient,
  input: SaveMeetingRecapInput,
): Promise<{ recapId: string; revisionNumber: number }> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, organization_id")
    .eq("id", input.meetingId)
    .single();
  if (meetingError) throw meetingError;

  const agreements = input.agreements ?? input.whatWeAgreed ?? [];
  const actions =
    input.actions ?? [
      ...(input.applyWizzWillDo ?? []),
      ...(input.customerShouldDo ?? input.candidateShouldDo ?? []),
    ];

  // 1. Upsert head recap row
  const { data: recap, error: recapError } = await supabase
    .from("meeting_recaps")
    .upsert(
      {
        meeting_id: input.meetingId,
        organization_id: meeting.organization_id,
        status: input.status ?? "draft",
      },
      { onConflict: "organization_id, meeting_id" },
    )
    .select("id")
    .single();

  if (recapError) throw recapError;

  // 2. Determine next revision number
  const { data: latestRev } = await supabase
    .from("meeting_recap_revisions")
    .select("revision_number")
    .eq("recap_id", recap.id)
    .order("revision_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextRevisionNumber = (latestRev?.revision_number ?? 0) + 1;

  // 3. Append-only revision insert
  const { error: revError } = await supabase
    .from("meeting_recap_revisions")
    .insert({
      organization_id: meeting.organization_id,
      recap_id: recap.id,
      revision_number: nextRevisionNumber,
      created_by_membership_id: input.actorMembershipId ?? null,
      greeting: input.greeting,
      agreements: agreements as unknown as Json,
      actions: actions as unknown as Json,
      next_step: input.nextStep,
      revision_reason: input.reason ?? "manual_edit",
    });

  if (revError) throw revError;

  return { recapId: recap.id, revisionNumber: nextRevisionNumber };
}

export interface ApproveMeetingRecapInput {
  meetingId: string;
  actorUserId: string;
  actorMembershipId: string;
  greeting?: string;
  agreements?: string[];
  actions?: string[];
  nextStep?: string;
  whatWeAgreed?: string[];
  applyWizzWillDo?: string[];
  customerShouldDo?: string[];
}

/**
 * AM Review Gate: Promotes a draft candidate recap to 'approved'.
 * Enforces the core product principle:
 * "Signal captures the evidence, AI interprets it, the Account Manager approves it,
 * and only then does anything go to the customer."
 * Plan A contains NO external delivery.
 */
export async function approveMeetingRecap(
  supabase: AppSupabaseClient,
  input: ApproveMeetingRecapInput,
): Promise<{ recapId: string; status: "approved" }> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, organization_id")
    .eq("id", input.meetingId)
    .single();
  if (meetingError) throw meetingError;

  let recapId: string;

  // If content is provided at approval time, record an approved snapshot revision
  if (input.greeting && input.nextStep) {
    const saved = await saveMeetingRecapDraft(supabase, {
      meetingId: input.meetingId,
      greeting: input.greeting,
      agreements: input.agreements,
      actions: input.actions,
      whatWeAgreed: input.whatWeAgreed,
      applyWizzWillDo: input.applyWizzWillDo,
      customerShouldDo: input.customerShouldDo,
      nextStep: input.nextStep,
      actorMembershipId: input.actorMembershipId,
      status: "ready_for_review",
      reason: "approved_snapshot",
    });
    recapId = saved.recapId;
  } else {
    const { data: existingRecap, error: recapError } = await supabase
      .from("meeting_recaps")
      .select("id")
      .eq("meeting_id", input.meetingId)
      .single();
    if (recapError) throw recapError;
    recapId = existingRecap.id;
  }

  const now = new Date().toISOString();

  // Transition head status to approved
  const { data, error } = await supabase
    .from("meeting_recaps")
    .update({
      status: "approved",
      approved_by_membership_id: input.actorMembershipId,
      approved_at: now,
    })
    .eq("id", recapId)
    .select("id")
    .single();

  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: meeting.organization_id,
    actorId: input.actorUserId,
    action: "meeting_recap.approved",
    entityType: "meeting",
    entityId: input.meetingId,
    metadata: {
      recapId: data.id,
      approvedByMembershipId: input.actorMembershipId,
    },
  });

  return { recapId: data.id, status: "approved" };
}

