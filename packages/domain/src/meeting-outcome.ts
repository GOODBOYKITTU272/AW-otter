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
  source: "persisted" | "derived";
}

export interface MeetingOutcomeSourceRecord {
  recordType: string;
  description: string;
  ownerType: string;
  ownerRef: string | null;
  dueAt: string | null;
  status?: string;
  evidenceSegmentIds: string[];
}

/**
 * Maps existing intelligence / call_records into the Overview schema so
 * Meeting Detail can render structured cards before (or without) a
 * dedicated meeting_outcomes row.
 */
export function deriveMeetingOutcomeFromRecords(input: {
  summary: string;
  callRecords: MeetingOutcomeSourceRecord[];
  model?: string;
  generatedAt?: string;
}): MeetingOutcomeData {
  return {
    summary: input.summary,
    keyDecisions: input.callRecords
      .filter((record) => record.recordType === "decision")
      .map((record) => ({
        text: record.description,
        evidenceSegmentIds: record.evidenceSegmentIds,
      })),
    actionItems: input.callRecords
      .filter((record) => record.recordType === "action_item")
      .map((record) => ({
        description: record.description,
        owner: record.ownerRef ?? record.ownerType,
        dueDate: record.dueAt,
        evidenceSegmentIds: record.evidenceSegmentIds,
      })),
    openQuestions: input.callRecords
      .filter((record) => record.recordType === "question")
      .map((record) => ({
        question: record.description,
        status: record.status === "answered" ? "answered" : "open",
        answer: null,
        evidenceSegmentIds: record.evidenceSegmentIds,
      })),
    model: input.model ?? "derived-from-intelligence",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    source: "derived",
  };
}

export function isMissingOutcomesTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /meeting_outcomes/i.test(error.message ?? "")
  );
}

/**
 * Fetches the persisted meeting outcome. Returns null when none exists yet
 * or when the table has not been migrated onto this database.
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

  if (error) {
    if (isMissingOutcomesTable(error)) return null;
    throw error;
  }
  if (!data) return null;

  return {
    summary: data.summary,
    keyDecisions: (data.key_decisions as unknown as MeetingOutcomeDecision[]) ?? [],
    actionItems: (data.action_items as unknown as MeetingOutcomeActionItem[]) ?? [],
    openQuestions: (data.open_questions as unknown as MeetingOutcomeQuestion[]) ?? [],
    model: data.model,
    generatedAt: data.generated_at,
    source: "persisted",
  };
}

/**
 * Prefer a persisted meeting_outcomes row; otherwise derive Overview cards
 * from existing recap / call_records so the tab is not blank.
 */
export function resolveMeetingOutcome(
  persisted: MeetingOutcomeData | null,
  recap: {
    result: {
      summary: string;
      callRecords: MeetingOutcomeSourceRecord[];
    };
  } | null,
): MeetingOutcomeData | null {
  if (persisted) return persisted;
  if (!recap?.result.summary) return null;
  return deriveMeetingOutcomeFromRecords({
    summary: recap.result.summary,
    callRecords: recap.result.callRecords,
  });
}
