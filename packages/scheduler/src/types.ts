/**
 * Raw response shape from GET /api/scheduler/calls, verified against the
 * real endpoint (readiness investigation, 2026-09-08). Fields beyond the
 * originally-documented contract (priority, summary, sentiment,
 * client_rating, client_feedback, is_preempted, reschedule_count,
 * created_at, updated_at) are real and present on every row observed.
 */
export interface RawSchedulerCall {
  id: string;
  lead_id: string;
  client_name: string | null;
  client_email: string | null;
  am_email: string;
  type: string;
  priority?: number | null;
  scheduled_at: string;
  ends_at?: string | null;
  status: string;
  summary?: string | null;
  sentiment?: string | null;
  client_rating?: number | null;
  is_preempted?: boolean | null;
  reschedule_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  teams_link?: string | null;
  teams_event_id?: string | null;
  teams_online_meeting_id?: string | null;
  client_feedback?: string | null;
}

export interface RawSchedulerCallsResponse {
  success: boolean;
  calls: RawSchedulerCall[];
}

/** Normalized, minimal shape the domain layer actually consumes. */
export interface SchedulerCall {
  externalCallId: string;
  leadId: string;
  clientName: string | null;
  clientEmail: string | null;
  amEmail: string;
  externalType: string;
  scheduledAt: string;
  endsAt: string | null;
  externalStatus: string;
  teamsLink: string | null;
  teamsEventId: string | null;
  teamsOnlineMeetingId: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
}

/**
 * Every value observed across the full live dataset (5,196 rows, all 9
 * AMs) at investigation time. Not exhaustive by contract — the scheduler
 * may add a new value without a Signal migration (mapExternalCallType in
 * @applywizz/domain falls back to 'other_unknown' for anything not in
 * this list, it never throws).
 */
export const KNOWN_SCHEDULER_CALL_TYPES = [
  "DISCOVERY",
  "ORIENTATION",
  "PROGRESS_REVIEW",
  "RENEWAL_DISCUSSION",
] as const;

export const KNOWN_SCHEDULER_CALL_STATUSES = [
  "SCHEDULED",
  "COMPLETED",
  "MISSED_BY_AM",
  "NOT_PICKED",
  "RESCHEDULED",
] as const;

export interface ListCallsParams {
  /**
   * Required. Never optional — omitting it (or passing "ALL") returns the
   * ENTIRE unauthenticated dataset across every AM (verified: readiness
   * investigation, 2026-09-08 — a real, currently-unfixed exposure on the
   * upstream endpoint). The client throws SchedulerProviderMisuseError
   * rather than ever making that request.
   */
  amEmail: string;
  type?: string;
  status?: string;
  from?: string;
  to?: string;
  leadId?: string;
  orderBy?: "created_at" | "scheduled_at";
}
