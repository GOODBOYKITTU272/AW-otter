import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import type { MeetingOutcomeProvider } from "@applywizz/ai";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Enqueues meeting outcome generation for all completed transcripts
 * that don't have an outcome yet.
 */
export async function enqueuePendingOutcomeGeneration(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<{ enqueued: number }> {
  const { data: transcripts, error: transcriptsError } = await supabase
    .from("meeting_transcripts")
    .select("id, meeting_id, organization_id")
    .eq("organization_id", organizationId)
    .eq("processing_status", "completed");

  if (transcriptsError) throw transcriptsError;

  if (!transcripts || transcripts.length === 0) {
    return { enqueued: 0 };
  }

  const { data: existingOutcomes, error: outcomesError } = await supabase
    .from("meeting_outcomes")
    .select("meeting_id")
    .in("meeting_id", transcripts.map((t) => t.meeting_id));

  if (outcomesError) throw outcomesError;

  const existingMeetingIds = new Set(
    (existingOutcomes ?? []).map((o) => o.meeting_id),
  );

  const pendingTranscripts = transcripts.filter(
    (t) => !existingMeetingIds.has(t.meeting_id),
  );

  return { enqueued: pendingTranscripts.length };
}

/**
 * Processes pending meeting outcomes by generating them via LLM.
 */
export async function processOutcomeQueue(
  supabase: AppSupabaseClient,
  deps: { provider: MeetingOutcomeProvider },
  limit: number = 5,
): Promise<{ processed: number; errors: string[] }> {
  const { data: transcripts, error: transcriptsError } = await supabase
    .from("meeting_transcripts")
    .select("id, meeting_id, organization_id")
    .eq("processing_status", "completed")
    .order("completed_at", { ascending: true })
    .limit(limit);

  if (transcriptsError) throw transcriptsError;

  if (!transcripts || transcripts.length === 0) {
    return { processed: 0, errors: [] };
  }

  const meetingIds = transcripts.map((t) => t.meeting_id);

  const { data: existingOutcomes, error: outcomesError } = await supabase
    .from("meeting_outcomes")
    .select("meeting_id")
    .in("meeting_id", meetingIds);

  if (outcomesError) throw outcomesError;

  const existingMeetingIds = new Set(
    (existingOutcomes ?? []).map((o) => o.meeting_id),
  );

  const pendingTranscripts = transcripts.filter(
    (t) => !existingMeetingIds.has(t.meeting_id),
  );

  let processed = 0;
  const errors: string[] = [];

  for (const transcript of pendingTranscripts) {
    try {
      await generateOutcome(supabase, transcript.meeting_id, deps.provider);
      processed++;
    } catch (error) {
      errors.push(
        `Meeting ${transcript.meeting_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { processed, errors };
}

/**
 * Generates a meeting outcome for a specific meeting.
 */
async function generateOutcome(
  supabase: AppSupabaseClient,
  meetingId: string,
  provider: MeetingOutcomeProvider,
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

  const { data: segments, error: segmentsError } = await supabase
    .from("transcript_segments")
    .select("id, canonical_english_text, original_text, speaker_label")
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });

  if (segmentsError) throw segmentsError;

  if (!segments || segments.length === 0) {
    throw new Error("No segments found for transcript");
  }

  const result = await provider.generate({
    meetingId,
    segments: segments.map((s) => ({
      id: s.id,
      text: s.canonical_english_text ?? s.original_text,
      speakerLabel: s.speaker_label,
    })),
  });

  const { error: insertError } = await supabase
    .from("meeting_outcomes")
    .upsert({
      organization_id: meeting.organization_id,
      meeting_id: meetingId,
      transcript_id: transcript.id,
      summary: result.outcome.summary,
      key_decisions: result.outcome.keyDecisions as unknown as Database["public"]["Tables"]["meeting_outcomes"]["Insert"]["key_decisions"],
      action_items: result.outcome.actionItems as unknown as Database["public"]["Tables"]["meeting_outcomes"]["Insert"]["action_items"],
      open_questions: result.outcome.openQuestions as unknown as Database["public"]["Tables"]["meeting_outcomes"]["Insert"]["open_questions"],
      model: result.model,
      usage_metadata: {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cost: result.usage.cost,
      } as unknown as Database["public"]["Tables"]["meeting_outcomes"]["Insert"]["usage_metadata"],
    }, {
      onConflict: "meeting_id",
    });

  if (insertError) throw insertError;
}
