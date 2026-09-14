import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

type AppSupabaseClient = SupabaseClient<Database>;

export interface MeetingOutcomeDecision {
  text: string;
  evidenceSegmentIds: string[];
}

export interface MeetingOutcomeActionItem {
  description: string;
  owner: string | null;
  dueDate: string | null;
  evidenceSegmentIds: string[];
}

export interface MeetingOutcomeQuestion {
  question: string;
  status: "open" | "answered";
  answer: string | null;
  evidenceSegmentIds: string[];
}

export interface MeetingOutcomeData {
  summary: string;
  keyDecisions: MeetingOutcomeDecision[];
  actionItems: MeetingOutcomeActionItem[];
  openQuestions: MeetingOutcomeQuestion[];
  model: string;
  generatedAt: string;
}

/**
 * Fetches the meeting outcome (Fathom-style structured overview) for a meeting.
 * Returns null if no outcome has been generated yet.
 */
export async function getMeetingOutcome(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<MeetingOutcomeData | null> {
  const { data, error } = await supabase
    .from("meeting_outcomes")
    .select("summary, key_decisions, action_items, open_questions, model, generated_at")
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    summary: data.summary,
    keyDecisions: (data.key_decisions as unknown as MeetingOutcomeDecision[]) ?? [],
    actionItems: (data.action_items as unknown as MeetingOutcomeActionItem[]) ?? [],
    openQuestions: (data.open_questions as unknown as MeetingOutcomeQuestion[]) ?? [],
    model: data.model,
    generatedAt: data.generated_at,
  };
}
