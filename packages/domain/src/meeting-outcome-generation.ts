import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import type { MeetingOutcomeProvider } from "@applywizz/ai";
import {
  deriveMeetingOutcomeFromRecords,
  isMissingOutcomesTable,
  type MeetingOutcomeData,
} from "./meeting-outcome";
import { groundMeetingOutcomeEvidence } from "./meeting-outcome-evidence";

type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Counts completed transcripts that do not yet have a meeting_outcomes row.
 */
export async function enqueuePendingOutcomeGeneration(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<{ enqueued: number }> {
  const { data: transcripts, error: transcriptsError } = await supabase
    .from("meeting_transcripts")
    .select("id, meeting_id")
    .eq("organization_id", organizationId)
    .eq("processing_status", "completed");

  if (transcriptsError) throw transcriptsError;
  if (!transcripts || transcripts.length === 0) {
    return { enqueued: 0 };
  }

  const { data: existingOutcomes, error: outcomesError } = await supabase
    .from("meeting_outcomes")
    .select("meeting_id")
    .in(
      "meeting_id",
      transcripts.map((t) => t.meeting_id),
    );

  if (outcomesError) {
    if (isMissingOutcomesTable(outcomesError)) return { enqueued: 0 };
    throw outcomesError;
  }

  const existingMeetingIds = new Set(
    (existingOutcomes ?? []).map((o) => o.meeting_id),
  );

  return {
    enqueued: transcripts.filter((t) => !existingMeetingIds.has(t.meeting_id))
      .length,
  };
}

/**
 * Backfills meeting_outcomes from existing intelligence when present,
 * otherwise runs the dedicated Meeting Outcome LLM over Canonical English.
 */
export async function processOutcomeQueue(
  supabase: AppSupabaseClient,
  deps: { provider: MeetingOutcomeProvider },
  limit: number = 5,
): Promise<{ processed: number; derived: number; generated: number; errors: string[] }> {
  const pending = await listMeetingsMissingOutcomes(supabase, Math.max(limit * 10, 20));
  const batch = pending.slice(0, limit);

  let processed = 0;
  let derived = 0;
  let generated = 0;
  const errors: string[] = [];

  for (const transcript of batch) {
    try {
      const source = await persistOutcomeForMeeting(
        supabase,
        transcript.meeting_id,
        deps.provider,
        { forceLlm: false },
      );
      processed += 1;
      if (source === "derived") derived += 1;
      if (source === "generated") generated += 1;
    } catch (error) {
      errors.push(
        `Meeting ${transcript.meeting_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { processed, derived, generated, errors };
}

/**
 * Admin / one-shot regenerate: overwrite the meeting_outcomes row.
 * forceLlm=true always re-runs the Outcome LLM (preferred after prompt fixes).
 * forceLlm=false prefers derive-from-intelligence when a completed ai_run exists.
 */
export async function regenerateMeetingOutcome(
  supabase: AppSupabaseClient,
  meetingId: string,
  provider: MeetingOutcomeProvider,
  options: { forceLlm?: boolean } = {},
): Promise<{ source: "derived" | "generated" }> {
  const source = await persistOutcomeForMeeting(
    supabase,
    meetingId,
    provider,
    { forceLlm: options.forceLlm ?? true },
  );
  return { source };
}

async function listMeetingsMissingOutcomes(
  supabase: AppSupabaseClient,
  scanLimit: number,
): Promise<Array<{ id: string; meeting_id: string; organization_id: string }>> {
  const { data: transcripts, error: transcriptsError } = await supabase
    .from("meeting_transcripts")
    .select("id, meeting_id, organization_id")
    .eq("processing_status", "completed")
    .order("completed_at", { ascending: true })
    .limit(scanLimit);

  if (transcriptsError) throw transcriptsError;
  if (!transcripts || transcripts.length === 0) return [];

  const { data: existingOutcomes, error: outcomesError } = await supabase
    .from("meeting_outcomes")
    .select("meeting_id")
    .in(
      "meeting_id",
      transcripts.map((t) => t.meeting_id),
    );

  if (outcomesError) {
    if (isMissingOutcomesTable(outcomesError)) return [];
    throw outcomesError;
  }

  const existingMeetingIds = new Set(
    (existingOutcomes ?? []).map((o) => o.meeting_id),
  );

  return transcripts.filter((t) => !existingMeetingIds.has(t.meeting_id));
}

async function persistOutcomeForMeeting(
  supabase: AppSupabaseClient,
  meetingId: string,
  provider: MeetingOutcomeProvider,
  options: { forceLlm: boolean },
): Promise<"derived" | "generated"> {
  if (!options.forceLlm) {
    const derived = await tryPersistDerivedOutcome(supabase, meetingId);
    if (derived) return "derived";
  }
  await generateOutcomeWithLlm(supabase, meetingId, provider);
  return "generated";
}

async function tryPersistDerivedOutcome(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<boolean> {
  const { data: completedRun, error: runError } = await supabase
    .from("ai_runs")
    .select("summary, model, completed_at")
    .eq("meeting_id", meetingId)
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (runError) throw runError;
  if (!completedRun?.summary) return false;

  const { data: callRecordRows, error: recordsError } = await supabase
    .from("call_records")
    .select(
      "record_type, description, owner_type, external_owner_name, due_at, status, evidence_segment_ids",
    )
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: true });
  if (recordsError) throw recordsError;

  const segments = await loadOutcomeSegments(supabase, meetingId);
  let outcome = deriveMeetingOutcomeFromRecords({
    summary: completedRun.summary,
    callRecords: (callRecordRows ?? []).map((row) => ({
      recordType: row.record_type,
      description: row.description,
      ownerType: row.owner_type,
      ownerRef: row.external_owner_name,
      dueAt: row.due_at,
      status: row.status,
      evidenceSegmentIds: row.evidence_segment_ids ?? [],
    })),
    model: completedRun.model,
    generatedAt: completedRun.completed_at ?? undefined,
  });

  if (segments.length > 0) {
    outcome = {
      ...groundMeetingOutcomeEvidence(outcome, segments),
      model: outcome.model,
      generatedAt: outcome.generatedAt,
      source: outcome.source,
    };
  }

  await upsertMeetingOutcome(supabase, meetingId, outcome, {
    promptTokens: null,
    completionTokens: null,
    cost: null,
  });
  return true;
}

async function generateOutcomeWithLlm(
  supabase: AppSupabaseClient,
  meetingId: string,
  provider: MeetingOutcomeProvider,
): Promise<void> {
  const segments = await loadOutcomeSegments(supabase, meetingId);
  if (segments.length === 0) {
    throw new Error("No segments found for transcript");
  }

  const result = await provider.generate({
    meetingId,
    segments: segments.map((s) => ({
      id: s.id,
      text: s.text,
      speakerLabel: s.speakerLabel,
    })),
  });

  const grounded = groundMeetingOutcomeEvidence(
    {
      summary: result.outcome.summary,
      keyDecisions: result.outcome.keyDecisions,
      actionItems: result.outcome.actionItems,
      openQuestions: result.outcome.openQuestions,
    },
    segments,
  );

  await upsertMeetingOutcome(
    supabase,
    meetingId,
    {
      summary: grounded.summary,
      keyDecisions: grounded.keyDecisions,
      actionItems: grounded.actionItems,
      openQuestions: grounded.openQuestions,
      model: result.model,
      generatedAt: new Date().toISOString(),
      source: "persisted",
    },
    result.usage,
  );
}

async function loadOutcomeSegments(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<Array<{ id: string; text: string; speakerLabel: string }>> {
  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select("id")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (transcriptError) throw transcriptError;
  if (!transcript) throw new Error("No transcript found for meeting");

  const { data: segments, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select("id, canonical_english_text, original_text, speaker_label")
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });
  if (segmentsError) throw segmentsError;

  return (segments ?? []).map((s) => ({
    id: s.id,
    text: s.canonical_english_text ?? s.original_text,
    speakerLabel: s.speaker_label,
  }));
}

async function upsertMeetingOutcome(
  supabase: AppSupabaseClient,
  meetingId: string,
  outcome: MeetingOutcomeData,
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cost: number | null;
  },
): Promise<void> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, organization_id")
    .eq("id", meetingId)
    .single();
  if (meetingError) throw meetingError;

  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select("id")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (transcriptError) throw transcriptError;
  if (!transcript) throw new Error("No transcript found for meeting");

  const { error: insertError } = await supabase.from("meeting_outcomes").upsert(
    {
      organization_id: meeting.organization_id,
      meeting_id: meetingId,
      transcript_id: transcript.id,
      summary: outcome.summary,
      key_decisions: outcome.keyDecisions as unknown as Json,
      action_items: outcome.actionItems as unknown as Json,
      open_questions: outcome.openQuestions as unknown as Json,
      model: outcome.model,
      usage_metadata: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cost: usage.cost,
        source: outcome.source,
      } as unknown as Json,
    },
    { onConflict: "meeting_id" },
  );

  if (insertError) throw insertError;
}
