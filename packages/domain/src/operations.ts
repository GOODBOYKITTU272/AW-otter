import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

// ponytail: one fixed threshold across all four queues for this first
// slice, not a per-queue tuned value — real-world processing durations
// vary (a bot "joining" a call plausibly takes longer than a transcript
// segment insert), so this WILL misclassify a legitimately-slow job as
// "stuck" sometimes. Raise it (or split per-queue) if that happens in
// practice; not worth guessing the right number before real operational
// data exists.
const STUCK_THRESHOLD_MINUTES = 30;

export interface QueueHealthItem {
  id: string;
  label: string;
  status: string;
  errorSummary: string | null;
  updatedAt: string;
}

export interface QueueHealth {
  queue: string;
  failedCount: number;
  failed: QueueHealthItem[];
  stuckCount: number;
  stuck: QueueHealthItem[];
}

function truncate(text: string | null, max = 200): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * M16: read-only operational visibility over the four existing job
 * queues (calendar_event_jobs, meeting_transcripts, ai_runs,
 * meeting_bot_jobs) — every one already has its own retry_count/
 * next_retry_at backoff (transcription.ts, meeting-intelligence.ts,
 * meeting-bots.ts) and its own admin-visible RLS policy
 * (calendar_event_jobs_select_admin_org, and the meeting-scoped ones
 * which admins see org-wide via meetings_select_admin_org) — this reads
 * through the CALLER's own client, no service-role, no new RLS.
 *
 * What none of the four have: any detection of a job stuck in an
 * active/processing-like state because the worker that claimed it
 * crashed or timed out before ever reaching its own success/failure
 * handler (a real gap — that job never gets retried, never shows up as
 * "failed", and nothing surfaces it). This function flags exactly that:
 * an active-state row whose `updated_at` hasn't moved in
 * STUCK_THRESHOLD_MINUTES. It does not attempt to auto-recover it —
 * detection first, recovery is a deliberate separate decision.
 */
export async function getOperationalHealth(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<QueueHealth[]> {
  const staleBefore = new Date(
    Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
  ).toISOString();

  // Deliberately excludes each queue's "pending"/queued-but-never-claimed
  // status — a row sitting in `pending` just means no worker tick has
  // drained it yet (normal, especially with no cron running, e.g. this
  // local dev environment), NOT evidence of a crash. Only a row already
  // CLAIMED by a worker (processing/running/scheduled/joining) that then
  // stops making progress is genuine "stuck" evidence. Conflating the two
  // would make a completely healthy backlog cry wolf.
  const [calendarRes, transcriptRes, aiRunRes, botRes] = await Promise.all([
    supabase
      .from("calendar_event_jobs")
      .select("id, external_event_id, status, last_error, updated_at")
      .eq("organization_id", organizationId)
      .in("status", ["processing", "failed", "dead_letter"])
      .order("updated_at", { ascending: true })
      .limit(50),
    supabase
      .from("meeting_transcripts")
      .select("id, meeting_id, processing_status, error_code, updated_at")
      .eq("organization_id", organizationId)
      .in("processing_status", ["processing", "failed"])
      .order("updated_at", { ascending: true })
      .limit(50),
    supabase
      .from("ai_runs")
      .select("id, meeting_id, status, error_code, updated_at")
      .eq("organization_id", organizationId)
      .in("status", ["running", "failed"])
      .order("updated_at", { ascending: true })
      .limit(50),
    supabase
      .from("meeting_bot_jobs")
      .select("id, meeting_id, status, last_error, updated_at")
      .eq("organization_id", organizationId)
      .in("status", ["scheduled", "joining", "failed"])
      .order("updated_at", { ascending: true })
      .limit(50),
  ]);
  if (calendarRes.error) throw calendarRes.error;
  if (transcriptRes.error) throw transcriptRes.error;
  if (aiRunRes.error) throw aiRunRes.error;
  if (botRes.error) throw botRes.error;

  const calendarItems = (calendarRes.data ?? []).map((r) => ({
    id: r.id,
    label: r.external_event_id,
    status: r.status,
    errorSummary: truncate(r.last_error),
    updatedAt: r.updated_at,
  }));
  const calendarActive = ["processing"];
  const calendarFailed = ["failed", "dead_letter"];

  const transcriptItems = (transcriptRes.data ?? []).map((r) => ({
    id: r.id,
    label: `Meeting ${r.meeting_id}`,
    status: r.processing_status,
    errorSummary: truncate(r.error_code),
    updatedAt: r.updated_at,
  }));
  const transcriptActive = ["processing"];
  const transcriptFailed = ["failed"];

  const aiRunItems = (aiRunRes.data ?? []).map((r) => ({
    id: r.id,
    label: `Meeting ${r.meeting_id}`,
    status: r.status,
    errorSummary: truncate(r.error_code),
    updatedAt: r.updated_at,
  }));
  const aiRunActive = ["running"];
  const aiRunFailed = ["failed"];

  const botItems = (botRes.data ?? []).map((r) => ({
    id: r.id,
    label: `Meeting ${r.meeting_id}`,
    status: r.status,
    errorSummary: truncate(r.last_error),
    updatedAt: r.updated_at,
  }));
  const botActive = ["scheduled", "joining"];
  const botFailed = ["failed"];

  function toHealth(
    queue: string,
    items: QueueHealthItem[],
    activeStatuses: string[],
    failedStatuses: string[],
  ): QueueHealth {
    const failed = items.filter((i) => failedStatuses.includes(i.status));
    const stuck = items.filter(
      (i) => activeStatuses.includes(i.status) && i.updatedAt < staleBefore,
    );
    return {
      queue,
      failedCount: failed.length,
      failed,
      stuckCount: stuck.length,
      stuck,
    };
  }
  return [
    toHealth("Calendar sync", calendarItems, calendarActive, calendarFailed),
    toHealth(
      "Transcription",
      transcriptItems,
      transcriptActive,
      transcriptFailed,
    ),
    toHealth("Meeting intelligence", aiRunItems, aiRunActive, aiRunFailed),
    toHealth("Meeting bot", botItems, botActive, botFailed),
  ];
}
