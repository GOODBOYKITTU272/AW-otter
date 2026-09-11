import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import {
  CURRENT_PROMPT_VERSION,
  CURRENT_PROVIDER_CONFIG_VERSION,
  DEFAULT_INTELLIGENCE_MODEL,
  IntelligenceApiError,
  IntelligenceMalformedResponseError,
  IntelligenceTimeoutError,
  MEETING_INTELLIGENCE_RUN_TYPE,
  type MeetingIntelligenceProvider,
} from "@applywizz/ai";
import { logLifecycleEvent } from "./meeting-bots";
import {
  evaluateAndPersistMeetingIntegrity,
  isEligibleForIntelligence,
  type IntegrityVerdict,
} from "./meeting-integrity";

export type AppSupabaseClient = SupabaseClient<Database>;

type AiRunRow = Database["public"]["Tables"]["ai_runs"]["Row"];

const MAX_RETRY_COUNT = 5;
const RETRY_BACKOFF_BASE_MS = 30_000;

function retryBackoff(retryCount: number): string {
  const delayMs = Math.min(
    RETRY_BACKOFF_BASE_MS * 2 ** retryCount,
    30 * 60 * 1000,
  );
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Scans every 'completed' transcript whose meeting has no ai_runs row yet
 * for the CURRENT identity (model/prompt_version/provider_config_version)
 * and enqueues one. Idempotent: ai_runs_identity_uq is the actual
 * enforcement (M9 correction #2) — a 23505 here just means another
 * concurrent scan (or a prior run with this exact identity) already
 * enqueued it. A model/prompt/config change naturally re-enqueues every
 * meeting under the new identity without touching old rows.
 */
export async function enqueuePendingIntelligenceRuns(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<{ enqueued: number }> {
  const { data: transcripts, error: transcriptsError } = await serviceRoleClient
    .from("meeting_transcripts")
    .select("id, meeting_id")
    .eq("organization_id", organizationId)
    .eq("processing_status", "completed");
  if (transcriptsError) throw transcriptsError;

  let enqueued = 0;
  for (const transcript of transcripts ?? []) {
    // Phase 4 HARD GATE: Ensure integrity is evaluated first, then check eligibility
    let integrityVerdict: IntegrityVerdict | null = null;
    try {
      const { data: existingReport } = await serviceRoleClient
        .from("meeting_integrity_reports")
        .select("overall_verdict")
        .eq("meeting_id", transcript.meeting_id)
        .eq("organization_id", organizationId)
        .maybeSingle();

      if (existingReport) {
        integrityVerdict = existingReport.overall_verdict as IntegrityVerdict;
      } else {
        // Evaluate integrity if not already done
        const analysis = await evaluateAndPersistMeetingIntegrity(
          serviceRoleClient,
          transcript.meeting_id,
          organizationId,
        );
        integrityVerdict = analysis.verdict;
      }
    } catch (err: unknown) {
      // If integrity evaluation fails, log and skip this meeting (conservative: don't process without verification)
      await logLifecycleEvent(serviceRoleClient, {
        meetingId: transcript.meeting_id,
        organizationId,
        eventType: "transcript.integrity_evaluation_failed",
        source: "worker",
        payload: { error: err instanceof Error ? err.message : "unknown" },
      }).catch(() => {});
      continue;
    }

    // INTEGRITY GATE: Block intelligence processing for FAIL verdicts
    if (integrityVerdict && !isEligibleForIntelligence(integrityVerdict)) {
      await logLifecycleEvent(serviceRoleClient, {
        meetingId: transcript.meeting_id,
        organizationId,
        eventType: "meeting_intelligence.blocked_by_integrity",
        source: "worker",
        payload: { verdict: integrityVerdict },
      });
      continue;
    }

    const { error: insertError } = await serviceRoleClient
      .from("ai_runs")
      .insert({
        organization_id: organizationId,
        meeting_id: transcript.meeting_id,
        transcript_id: transcript.id,
        run_type: MEETING_INTELLIGENCE_RUN_TYPE,
        model: DEFAULT_INTELLIGENCE_MODEL,
        prompt_version: CURRENT_PROMPT_VERSION,
        provider_config_version: CURRENT_PROVIDER_CONFIG_VERSION,
        status: "pending",
      });
    if (insertError) {
      if (insertError.code === "23505") continue; // already enqueued under this identity — fine
      throw insertError;
    }
    enqueued += 1;
    await logLifecycleEvent(serviceRoleClient, {
      meetingId: transcript.meeting_id,
      organizationId,
      eventType: "meeting_intelligence.enqueued",
      source: "worker",
    });
  }

  return { enqueued };
}

export interface MeetingIntelligenceDeps {
  provider: MeetingIntelligenceProvider;
}

type FailureCode =
  | "intelligence_failed"
  | "intelligence_timeout"
  | "intelligence_malformed_response"
  | "unknown";

function classifyError(error: unknown): { code: FailureCode; message: string } {
  if (error instanceof Error) {
    if (
      error.name === "IntelligenceTimeoutError" ||
      error instanceof IntelligenceTimeoutError
    ) {
      return { code: "intelligence_timeout", message: error.message };
    }
    if (
      error.name === "IntelligenceMalformedResponseError" ||
      error instanceof IntelligenceMalformedResponseError
    ) {
      return {
        code: "intelligence_malformed_response",
        message: error.message,
      };
    }
    if (
      error.name === "IntelligenceApiError" ||
      error instanceof IntelligenceApiError
    ) {
      return { code: "intelligence_failed", message: error.message };
    }
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}

/**
 * Processes one claimed ai_runs row: loads the meeting's call_type and
 * transcript segments, calls the provider, and atomically persists via
 * complete_meeting_intelligence_run. Uses canonical_english_text when
 * available (falls back to original_text for an English-source segment,
 * which M8 already made identical) so the provider only ever reasons over
 * English text.
 *
 * Codex implementation review (BLOCKING, fixed): extraction/persistence
 * and best-effort follow-up work (materialize_customer_truth_deltas,
 * lifecycle logging) used to share one try/catch. If the follow-up work
 * threw AFTER complete_meeting_intelligence_run had already succeeded, the
 * catch block rewrote the now-completed run back to 'retryable'/'failed'
 * — claim_next_meeting_intelligence_run would then reclaim it, call the
 * AI provider a second time, and complete_meeting_intelligence_run (which
 * only refuses an already-'completed' row) would insert a SECOND set of
 * call_records for the same ai_run_id. Extraction/persistence now has its
 * own try/catch (the only one allowed to move ai_runs out of 'completed');
 * once that succeeds, follow-up work runs in a separate try/catch that
 * never touches ai_runs.status on failure — materialization is safe to
 * leave for the periodic sweep (materializeReadyCustomerTruthDeltas) to
 * pick up later, and a failed lifecycle-event write is not worth
 * resurrecting an already-persisted, evidence-grade run for.
 */
export async function processIntelligenceRun(
  serviceRoleClient: AppSupabaseClient,
  run: AiRunRow,
  deps: MeetingIntelligenceDeps,
): Promise<void> {
  let callRecordCount = 0;
  let customerTruthDeltaCount = 0;

  try {
    // Phase 4 DEFENSE IN DEPTH: Verify integrity eligibility before processing
    const { data: integrityReport, error: integrityError } = await serviceRoleClient
      .from("meeting_integrity_reports")
      .select("overall_verdict")
      .eq("meeting_id", run.meeting_id)
      .eq("organization_id", run.organization_id)
      .maybeSingle();
    if (integrityError) throw integrityError;

    if (integrityReport) {
      const verdict = integrityReport.overall_verdict as IntegrityVerdict;
      if (!isEligibleForIntelligence(verdict)) {
        // INTEGRITY GATE: Refuse to process FAIL verdicts
        throw new Error(
          `Transcript integrity FAIL (${verdict}): AI intelligence processing blocked`,
        );
      }
    }

    const { data: meeting, error: meetingError } = await serviceRoleClient
      .from("meetings")
      .select("call_type")
      .eq("id", run.meeting_id)
      .eq("organization_id", run.organization_id)
      .single();
    if (meetingError) throw meetingError;

    const { data: segments, error: segmentsError } = await serviceRoleClient
      .from("transcript_segments")
      .select("id, original_text, canonical_english_text, speaker_label")
      .eq("transcript_id", run.transcript_id)
      .order("sequence_index", { ascending: true });
    if (segmentsError) throw segmentsError;

    const providerResult = await deps.provider.extract({
      meetingId: run.meeting_id,
      callType: meeting.call_type,
      segments: (segments ?? []).map((s) => ({
        id: s.id,
        text: s.canonical_english_text ?? s.original_text,
        speakerLabel: s.speaker_label,
      })),
    });

    const callRecordRows = providerResult.result.callRecords.map((rec) => ({
      record_type: rec.recordType,
      description: rec.description,
      owner_type: rec.ownerType,
      // ownerRef is an AI-provided free-text hint, never a resolved
      // membership id — resolving an untrusted string to a real
      // organization_memberships.id would be a spoofing risk. It's always
      // recorded as external_owner_name only.
      external_owner_name: rec.ownerRef,
      evidence_segment_ids: rec.evidenceSegmentIds,
      due_at: rec.dueAt,
    }));
    callRecordCount = callRecordRows.length;
    customerTruthDeltaCount = providerResult.result.customerTruthDeltas.length;

    const { data: completed, error: completeError } =
      await serviceRoleClient.rpc("complete_meeting_intelligence_run", {
        p_run_id: run.id,
        p_organization_id: run.organization_id,
        p_summary: providerResult.result.summary,
        p_validated_output: providerResult.result as unknown as Json,
        p_usage_metadata: {
          model: providerResult.model,
          promptTokens: providerResult.usage.promptTokens,
          completionTokens: providerResult.usage.completionTokens,
          cost: providerResult.usage.cost,
          providerMetadata: providerResult.providerMetadata,
        } as Json,
        p_call_records: callRecordRows as unknown as Json,
      });
    if (completeError) throw completeError;
    if (!completed) {
      // Already completed by a concurrent run — not an error, just a lost race.
      return;
    }
  } catch (error) {
    const { code, message } = classifyError(error);
    const nextRetryCount = run.retry_count + 1;
    const terminal = nextRetryCount >= MAX_RETRY_COUNT;

    const { error: updateError } = await serviceRoleClient
      .from("ai_runs")
      .update({
        status: terminal ? "failed" : "retryable",
        error_code: code,
        safe_error_metadata: { message } as Json,
        retry_count: nextRetryCount,
        next_retry_at: terminal ? null : retryBackoff(nextRetryCount),
      })
      .eq("id", run.id)
      .eq("organization_id", run.organization_id);
    if (updateError) throw updateError;

    await logLifecycleEvent(serviceRoleClient, {
      meetingId: run.meeting_id,
      organizationId: run.organization_id,
      eventType: `meeting_intelligence.${terminal ? "failed" : "retry_scheduled"}`,
      source: "worker",
      payload: { errorCode: code },
    });
    return;
  }

  // Extraction/persistence is DONE and durable at this point. Follow-up
  // work below is best-effort and must never revert ai_runs' status.
  try {
    // Safe to call unconditionally — no-ops if the meeting is still
    // unlinked (M9 correction #1: deltas stay preserved in
    // ai_runs.validated_output, not discarded). Also invoked by the
    // periodic sweep, so a failure here is not a lost opportunity.
    const { error: materializeError } = await serviceRoleClient.rpc(
      "materialize_customer_truth_deltas",
      { p_run_id: run.id, p_organization_id: run.organization_id },
    );
    if (materializeError) throw materializeError;

    await logLifecycleEvent(serviceRoleClient, {
      meetingId: run.meeting_id,
      organizationId: run.organization_id,
      eventType: "meeting_intelligence.completed",
      source: "worker",
      payload: { callRecordCount, customerTruthDeltaCount },
    });
  } catch (error) {
    const { code, message } = classifyError(error);
    await logLifecycleEvent(serviceRoleClient, {
      meetingId: run.meeting_id,
      organizationId: run.organization_id,
      eventType: "meeting_intelligence.followup_failed",
      source: "worker",
      payload: { errorCode: code, message },
    }).catch(() => {
      // Logging the logging failure would be pointless — the run itself
      // already succeeded and is durably 'completed'; nothing more to do.
    });
  }
}

export interface ProcessIntelligenceQueueResult {
  claimed: number;
  completed: number;
  failedOrRetrying: number;
}

/** Drains up to maxJobs pending/retryable ai_runs, one atomic claim (claim_next_meeting_intelligence_run, FOR UPDATE SKIP LOCKED) at a time. */
export async function processIntelligenceQueue(
  serviceRoleClient: AppSupabaseClient,
  deps: MeetingIntelligenceDeps,
  maxJobs = 5,
): Promise<ProcessIntelligenceQueueResult> {
  const result: ProcessIntelligenceQueueResult = {
    claimed: 0,
    completed: 0,
    failedOrRetrying: 0,
  };

  for (let i = 0; i < maxJobs; i += 1) {
    const { data: run, error: claimError } = await serviceRoleClient.rpc(
      "claim_next_meeting_intelligence_run",
    );
    if (claimError) throw claimError;
    if (!run?.id) break;

    result.claimed += 1;
    await processIntelligenceRun(serviceRoleClient, run, deps);

    const { data: refreshed, error: refreshError } = await serviceRoleClient
      .from("ai_runs")
      .select("status")
      .eq("id", run.id)
      .eq("organization_id", run.organization_id)
      .single();
    if (refreshError) throw refreshError;
    if (refreshed.status === "completed") result.completed += 1;
    else result.failedOrRetrying += 1;
  }

  return result;
}

/**
 * Periodic sweep (same idiom as M4/M5/M6/M7A's own reconciliation jobs):
 * catches the deferred case from M9 correction #1 — a meeting whose AI run
 * completed while still unlinked, and has since been linked to a customer.
 * Each call is a redundant-but-safe RPC invocation; no second AI call is
 * ever made.
 */
export async function materializeReadyCustomerTruthDeltas(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<{ materialized: number }> {
  // Codex implementation review (SHOULD-FIX, fixed): the RPC itself no-ops
  // safely for a still-unlinked meeting, but scanning every historical
  // unlinked-and-completed run on every tick is O(all of them) forever —
  // an inner join against meetings.customer_id restricts the scan to
  // candidates that can actually materialize something.
  const { data: runs, error } = await serviceRoleClient
    .from("ai_runs")
    .select("id, meetings!inner(customer_id)")
    .eq("organization_id", organizationId)
    .eq("status", "completed")
    .is("customer_truth_materialized_at", null)
    .not("meetings.customer_id", "is", null);
  if (error) throw error;

  let materialized = 0;
  for (const run of runs ?? []) {
    const { data: didMaterialize, error: materializeError } =
      await serviceRoleClient.rpc("materialize_customer_truth_deltas", {
        p_run_id: run.id,
        p_organization_id: organizationId,
      });
    if (materializeError) throw materializeError;
    if (didMaterialize) materialized += 1;
  }

  return { materialized };
}
