export type TimelineStepState =
  | "done"
  | "active"
  | "pending"
  | "failed"
  | "skipped";

export interface TimelineStep {
  key: "found" | "joined" | "recording" | "transcript" | "analysis";
  label: string;
  state: TimelineStepState;
  at: string | null;
}

export interface TimelineBotJobInput {
  status: string;
  joinedAt: string | null;
  leftAt: string | null;
  cancelledAt: string | null;
  failedAt: string | null;
}

export interface TimelineTranscriptInput {
  processingStatus: string;
  completedAt: string | null;
}

export type TimelineIntelligenceStatus =
  | "ready"
  | "not_ready"
  | "failed"
  | "unknown";

export interface TimelineInput {
  meetingCreatedAt: string;
  botJob: TimelineBotJobInput | null;
  transcript: TimelineTranscriptInput | null;
  intelligenceStatus: TimelineIntelligenceStatus;
}

const BOT_HAS_JOINED = new Set(["joined", "completed"]);

/**
 * Pure, human-facing version of the meeting lifecycle — separate from the
 * technical bot_status/processing_status enums, which stay available under
 * admin-only Technical details. Never invents a state: every step is
 * derived from a real row this page already fetched, and "skipped" (not
 * "pending") is used for a step that will never happen for this meeting
 * (no bot job at all means recording was never eligible), so the UI never
 * implies something is still coming when it isn't.
 */
export function computeProcessingTimeline(input: TimelineInput): TimelineStep[] {
  const steps: TimelineStep[] = [
    { key: "found", label: "Meeting found", state: "done", at: input.meetingCreatedAt },
  ];

  const job = input.botJob;
  if (!job) {
    steps.push({ key: "joined", label: "Assistant joined", state: "skipped", at: null });
    steps.push({ key: "recording", label: "Recording", state: "skipped", at: null });
  } else if (job.status === "failed") {
    steps.push({ key: "joined", label: "Assistant joined", state: "failed", at: job.failedAt });
    steps.push({ key: "recording", label: "Recording", state: "skipped", at: null });
  } else if (job.status === "cancelled") {
    steps.push({ key: "joined", label: "Assistant joined", state: "skipped", at: job.cancelledAt });
    steps.push({ key: "recording", label: "Recording", state: "skipped", at: null });
  } else if (BOT_HAS_JOINED.has(job.status) || job.joinedAt) {
    steps.push({ key: "joined", label: "Assistant joined", state: "done", at: job.joinedAt });
    steps.push(
      job.status === "completed"
        ? { key: "recording", label: "Recording", state: "done", at: job.leftAt }
        : { key: "recording", label: "Recording", state: "active", at: null },
    );
  } else {
    // pending / scheduled / joining — requested, not in the meeting yet.
    steps.push({ key: "joined", label: "Assistant joined", state: "active", at: null });
    steps.push({ key: "recording", label: "Recording", state: "pending", at: null });
  }

  const transcript = input.transcript;
  if (!transcript) {
    steps.push({ key: "transcript", label: "Transcript ready", state: "pending", at: null });
  } else if (transcript.processingStatus === "completed") {
    steps.push({ key: "transcript", label: "Transcript ready", state: "done", at: transcript.completedAt });
  } else if (transcript.processingStatus === "failed") {
    steps.push({ key: "transcript", label: "Transcript ready", state: "failed", at: null });
  } else {
    steps.push({ key: "transcript", label: "Transcript ready", state: "active", at: null });
  }

  if (input.intelligenceStatus === "ready") {
    steps.push({ key: "analysis", label: "Analysis ready", state: "done", at: null });
  } else if (input.intelligenceStatus === "failed") {
    steps.push({ key: "analysis", label: "Analysis ready", state: "failed", at: null });
  } else if (input.intelligenceStatus === "not_ready") {
    steps.push({ key: "analysis", label: "Analysis ready", state: "active", at: null });
  } else {
    steps.push({ key: "analysis", label: "Analysis ready", state: "pending", at: null });
  }

  return steps;
}
