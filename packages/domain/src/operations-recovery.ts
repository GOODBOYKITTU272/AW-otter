import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import type { MeetingBotProvider } from "@applywizz/meeting-bots";
import { recordIncident, resolveIncident } from "./operational-incidents";

export type AppSupabaseClient = SupabaseClient<Database>;

// Same ceiling and backoff formula already used by every queue's own
// caught-error retry path (transcription.ts, meeting-intelligence.ts,
// meetings.ts's calendar sync) — meeting_bot_jobs has no such ceiling on
// its own claim-side retry path today, so this is a genuinely NEW bound
// for that one queue's recovery path specifically (an unbounded
// stuck-recovery retry loop would be a real new bug this file must not
// introduce).
const MAX_RETRY_COUNT = 5;
const BACKOFF_BASE_MS = 30_000;
const STUCK_THRESHOLD_MINUTES = 30;

function backoff(retryCount: number): string {
  const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** retryCount, 30 * 60 * 1000);
  return new Date(Date.now() + delayMs).toISOString();
}

export interface RecoveryOutcome {
  recovered: number;
  terminated: number;
}

/**
 * The actual claim: matches BOTH the exact active status AND the exact
 * updated_at this call read, mirroring meeting-bots.ts's own
 * `.eq("status", "pending").eq("retry_count", job.retry_count)` CAS
 * claim verbatim. If the original worker finishes (or another recovery
 * sweep already recovered this row) in between, `updated_at` no longer
 * matches, zero rows are affected, and `claimed` comes back null — this
 * is the entire idempotency/concurrency-safety guarantee, not a separate
 * lock.
 */
async function recoverCalendarSync(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<RecoveryOutcome> {
  const staleBefore = new Date(
    Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
  ).toISOString();
  const { data: stuckRows, error } = await supabase
    .from("calendar_event_jobs")
    .select("id, status, attempts, updated_at")
    .eq("organization_id", organizationId)
    .eq("status", "processing")
    .lt("updated_at", staleBefore);
  if (error) throw error;

  let recovered = 0;
  let terminated = 0;
  for (const row of stuckRows ?? []) {
    const nextAttempts = row.attempts + 1;
    const terminal = nextAttempts >= MAX_RETRY_COUNT;
    const { data: claimed, error: claimError } = await supabase
      .from("calendar_event_jobs")
      .update(
        terminal
          ? {
              status: "dead_letter",
              attempts: nextAttempts,
              last_error: "worker_stuck_timeout",
            }
          : {
              status: "pending",
              attempts: nextAttempts,
              last_error: "worker_stuck_timeout",
              run_at: backoff(nextAttempts),
            },
      )
      .eq("id", row.id)
      .eq("organization_id", organizationId)
      .eq("status", row.status)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue; // lost the race — someone else already handled it

    if (terminal) {
      // No incident recorded here on purpose (M16 review fix 1):
      // syncIncidentsWithCurrentState is the ONE canonical source of
      // terminal_failure incidents, called right after this in the same
      // request. Recording one here too created two open incidents
      // (recovery_exhausted + terminal_failure) for the same exhaustion
      // event, every time.
      terminated++;
    } else {
      recovered++;
      await recordIncident(supabase, {
        organizationId,
        queue: "calendar_sync",
        entityId: row.id,
        incidentType: "stuck",
        severity: "warning",
        reason: "worker_stuck_timeout: recovered, retry scheduled",
      });
    }
  }
  return { recovered, terminated };
}

async function recoverTranscription(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<RecoveryOutcome> {
  const staleBefore = new Date(
    Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
  ).toISOString();
  const { data: stuckRows, error } = await supabase
    .from("meeting_transcripts")
    .select("id, meeting_id, processing_status, retry_count, updated_at")
    .eq("organization_id", organizationId)
    .eq("processing_status", "processing")
    .lt("updated_at", staleBefore);
  if (error) throw error;

  let recovered = 0;
  let terminated = 0;
  for (const row of stuckRows ?? []) {
    const nextRetryCount = row.retry_count + 1;
    const terminal = nextRetryCount >= MAX_RETRY_COUNT;
    const { data: claimed, error: claimError } = await supabase
      .from("meeting_transcripts")
      .update({
        processing_status: terminal ? "failed" : "retryable",
        error_code: "worker_stuck_timeout",
        safe_error_metadata: {
          message: "Recovered by operations sweep: no progress within threshold.",
        } as Json,
        retry_count: nextRetryCount,
        next_retry_at: terminal ? null : backoff(nextRetryCount),
      })
      .eq("id", row.id)
      .eq("organization_id", organizationId)
      .eq("processing_status", row.processing_status)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;

    if (terminal) {
      // See recoverCalendarSync's comment: intentionally no incident here.
      terminated++;
    } else {
      recovered++;
      await recordIncident(supabase, {
        organizationId,
        queue: "transcription",
        entityId: row.id,
        meetingId: row.meeting_id,
        incidentType: "stuck",
        severity: "warning",
        reason: "worker_stuck_timeout: recovered, retry scheduled",
      });
    }
  }
  return { recovered, terminated };
}

async function recoverMeetingIntelligence(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<RecoveryOutcome> {
  const staleBefore = new Date(
    Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
  ).toISOString();
  const { data: stuckRows, error } = await supabase
    .from("ai_runs")
    .select("id, meeting_id, status, retry_count, updated_at")
    .eq("organization_id", organizationId)
    .eq("status", "running")
    .lt("updated_at", staleBefore);
  if (error) throw error;

  let recovered = 0;
  let terminated = 0;
  for (const row of stuckRows ?? []) {
    const nextRetryCount = row.retry_count + 1;
    const terminal = nextRetryCount >= MAX_RETRY_COUNT;
    const { data: claimed, error: claimError } = await supabase
      .from("ai_runs")
      .update({
        status: terminal ? "failed" : "retryable",
        error_code: "worker_stuck_timeout",
        safe_error_metadata: {
          message: "Recovered by operations sweep: no progress within threshold.",
        } as Json,
        retry_count: nextRetryCount,
        next_retry_at: terminal ? null : backoff(nextRetryCount),
      })
      .eq("id", row.id)
      .eq("organization_id", organizationId)
      .eq("status", row.status)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;

    if (terminal) {
      // See recoverCalendarSync's comment: intentionally no incident here.
      terminated++;
    } else {
      recovered++;
      await recordIncident(supabase, {
        organizationId,
        queue: "meeting_intelligence",
        entityId: row.id,
        meetingId: row.meeting_id,
        incidentType: "stuck",
        severity: "warning",
        reason: "worker_stuck_timeout: recovered, retry scheduled",
      });
    }
  }
  return { recovered, terminated };
}

/**
 * M16 review fix 4: unlike the other three queues (pure DB/compute,
 * safely idempotent on retry), a stuck meeting-bot job has a REAL
 * external side effect if requeued wrong — a second live bot actually
 * joining the call while the first one is merely slow rather than dead.
 * `updated_at` staleness alone is not enough signal here. Before
 * requeuing, ask the provider (via the same MeetingBotProvider
 * abstraction every other bot code path already uses — no Vexa-specific
 * logic leaks into this file) whether it still considers the bot
 * live. Three outcomes, deliberately asymmetric:
 *   - provider confirms still joining/joined: NOT stuck, just slow —
 *     leave the row untouched entirely, no state change, no incident.
 *   - provider confirms it's gone (any other status, including its own
 *     "not found" case, which the Vexa adapter already normalizes to
 *     'completed'): safe to run through the normal recovery path below.
 *   - the provider call itself throws (network/outage/unknown): fail
 *     SAFE — never requeue on an unknown answer, since that's exactly
 *     the scenario that could create a duplicate join. Record an
 *     incident and leave the row alone; the next sweep tries again.
 * A row with no provider_bot_id yet (crashed before ever contacting the
 * provider) has nothing to check and goes straight to normal recovery.
 */
async function recoverMeetingBot(
  supabase: AppSupabaseClient,
  provider: MeetingBotProvider,
  organizationId: string,
): Promise<RecoveryOutcome> {
  const staleBefore = new Date(
    Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000,
  ).toISOString();
  const { data: stuckRows, error } = await supabase
    .from("meeting_bot_jobs")
    .select("id, meeting_id, status, retry_count, updated_at, provider_bot_id")
    .eq("organization_id", organizationId)
    .in("status", ["scheduled", "joining"])
    .lt("updated_at", staleBefore);
  if (error) throw error;

  let recovered = 0;
  let terminated = 0;
  for (const row of stuckRows ?? []) {
    if (row.provider_bot_id) {
      let stillLive: boolean;
      try {
        const providerStatus = await provider.getBotStatus(
          row.provider_bot_id,
        );
        stillLive =
          providerStatus.status === "joining" ||
          providerStatus.status === "joined";
      } catch {
        await recordIncident(supabase, {
          organizationId,
          queue: "meeting_bot",
          entityId: row.id,
          meetingId: row.meeting_id,
          incidentType: "provider_check_failed",
          severity: "warning",
          reason: "worker_stuck_timeout: provider status check failed, recovery deferred",
        });
        continue;
      }
      if (stillLive) continue; // genuinely still active — not stuck, leave alone
    }

    const nextRetryCount = row.retry_count + 1;
    const terminal = nextRetryCount >= MAX_RETRY_COUNT;
    const { data: claimed, error: claimError } = await supabase
      .from("meeting_bot_jobs")
      .update(
        terminal
          ? {
              status: "failed",
              last_error: "worker_stuck_timeout",
              failed_at: new Date().toISOString(),
            }
          : {
              status: "pending",
              last_error: "worker_stuck_timeout",
              retry_count: nextRetryCount,
              next_retry_at: backoff(nextRetryCount),
            },
      )
      .eq("id", row.id)
      .eq("organization_id", organizationId)
      .eq("status", row.status)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue;

    if (terminal) {
      // See recoverCalendarSync's comment: intentionally no incident here.
      terminated++;
    } else {
      recovered++;
      await recordIncident(supabase, {
        organizationId,
        queue: "meeting_bot",
        entityId: row.id,
        meetingId: row.meeting_id,
        incidentType: "stuck",
        severity: "warning",
        reason: "worker_stuck_timeout: recovered, retry scheduled",
      });
    }
  }
  return { recovered, terminated };
}

export interface QueueRecoveryResult extends RecoveryOutcome {
  queue: string;
}

/**
 * M16 Slice A/B combined entry point: recovers every genuinely-stuck row
 * (claimed by a worker that never finished) across all four queues for
 * one organization, then resolves any open incident whose underlying row
 * is no longer failed/stuck. Called only from
 * /api/internal/operations/recover (service_role, secret-gated) — never
 * from a browser-facing request.
 */
export async function recoverStuckJobs(
  supabase: AppSupabaseClient,
  provider: MeetingBotProvider,
  organizationId: string,
): Promise<QueueRecoveryResult[]> {
  const [calendarSync, transcription, meetingIntelligence, meetingBot] =
    await Promise.all([
      recoverCalendarSync(supabase, organizationId),
      recoverTranscription(supabase, organizationId),
      recoverMeetingIntelligence(supabase, organizationId),
      recoverMeetingBot(supabase, provider, organizationId),
    ]);

  return [
    { queue: "calendar_sync", ...calendarSync },
    { queue: "transcription", ...transcription },
    { queue: "meeting_intelligence", ...meetingIntelligence },
    { queue: "meeting_bot", ...meetingBot },
  ];
}

/**
 * Records/updates a terminal_failure incident for every row currently
 * sitting in a terminal failed state (independent of whether the
 * recovery sweep above just put it there), and resolves any open
 * incident for a row that is no longer in a bad state. Kept separate
 * from recoverStuckJobs so "what's currently broken" (this) and "what
 * did the sweep just fix" (recoverStuckJobs) are each independently
 * testable and independently callable.
 */
export async function syncIncidentsWithCurrentState(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<void> {
  const [calendarRows, transcriptRows, aiRunRows, botRows] =
    await Promise.all([
      supabase
        .from("calendar_event_jobs")
        .select("id, status, last_error")
        .eq("organization_id", organizationId),
      supabase
        .from("meeting_transcripts")
        .select("id, meeting_id, processing_status, error_code")
        .eq("organization_id", organizationId),
      supabase
        .from("ai_runs")
        .select("id, meeting_id, status, error_code")
        .eq("organization_id", organizationId),
      supabase
        .from("meeting_bot_jobs")
        .select("id, meeting_id, status, last_error")
        .eq("organization_id", organizationId),
    ]);
  if (calendarRows.error) throw calendarRows.error;
  if (transcriptRows.error) throw transcriptRows.error;
  if (aiRunRows.error) throw aiRunRows.error;
  if (botRows.error) throw botRows.error;

  for (const r of calendarRows.data ?? []) {
    if (r.status === "dead_letter" || r.status === "failed") {
      await recordIncident(supabase, {
        organizationId,
        queue: "calendar_sync",
        entityId: r.id,
        incidentType: "terminal_failure",
        severity: "critical",
        reason: `job status: ${r.status}${r.last_error ? ` (${r.last_error})` : ""}`,
      });
    } else {
      await resolveIncident(supabase, {
        organizationId,
        queue: "calendar_sync",
        entityId: r.id,
      });
    }
  }
  for (const r of transcriptRows.data ?? []) {
    if (r.processing_status === "failed") {
      await recordIncident(supabase, {
        organizationId,
        queue: "transcription",
        entityId: r.id,
        meetingId: r.meeting_id,
        incidentType: "terminal_failure",
        severity: "critical",
        reason: `job status: ${r.processing_status}${r.error_code ? ` (${r.error_code})` : ""}`,
      });
    } else {
      await resolveIncident(supabase, {
        organizationId,
        queue: "transcription",
        entityId: r.id,
      });
    }
  }
  for (const r of aiRunRows.data ?? []) {
    if (r.status === "failed") {
      await recordIncident(supabase, {
        organizationId,
        queue: "meeting_intelligence",
        entityId: r.id,
        meetingId: r.meeting_id,
        incidentType: "terminal_failure",
        severity: "critical",
        reason: `job status: ${r.status}${r.error_code ? ` (${r.error_code})` : ""}`,
      });
    } else {
      await resolveIncident(supabase, {
        organizationId,
        queue: "meeting_intelligence",
        entityId: r.id,
      });
    }
  }
  for (const r of botRows.data ?? []) {
    if (r.status === "failed") {
      await recordIncident(supabase, {
        organizationId,
        queue: "meeting_bot",
        entityId: r.id,
        meetingId: r.meeting_id,
        incidentType: "terminal_failure",
        severity: "critical",
        reason: `job status: ${r.status}${r.last_error ? ` (${r.last_error})` : ""}`,
      });
    } else {
      await resolveIncident(supabase, {
        organizationId,
        queue: "meeting_bot",
        entityId: r.id,
      });
    }
  }
}
