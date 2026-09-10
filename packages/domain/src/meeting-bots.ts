import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import type { MeetingBotProvider } from "@applywizz/meeting-bots";

export type AppSupabaseClient = SupabaseClient<Database>;

const BOT_NAME = "ApplyWizz Meeting Assistant";
const TERMINAL_STATUSES = ["completed", "cancelled", "failed"] as const;
const LIVE_FILTER = `(${TERMINAL_STATUSES.join(",")})`;

// M17C follow-up: confirmed live that dispatching the instant a meeting
// becomes eligible — no matter how far in the future it starts — sends
// the bot into an empty Teams lobby with nobody able to admit it, and
// Vexa eventually gives up with zero recording. This is the safe
// default; the real per-org value lives on meeting_policy_sets
// (bot_dispatch_lead_seconds), NOT NULL DEFAULT 90 at the DB level, so
// this constant is only ever reached when a row is missing entirely
// (e.g. an org that has never had its policy set touched).
const DEFAULT_BOT_DISPATCH_LEAD_SECONDS = 90;

// A meeting discovered/still-pending well after its own scheduled_end is
// not "late" so much as over — dispatching a bot into a room that's
// already finished is a real cost, not a useful safety margin. Small
// fixed grace, not configurable: this covers clock skew and the 1-minute
// poll cadence, not a product decision the way the lead time is.
const LATE_DISCOVERY_GRACE_MS = 5 * 60 * 1000;

export async function logLifecycleEvent(
  serviceRoleClient: AppSupabaseClient,
  input: {
    meetingId: string;
    organizationId: string;
    botJobId?: string | null;
    eventType: string;
    source: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await serviceRoleClient
    .from("meeting_lifecycle_events")
    .insert({
      meeting_id: input.meetingId,
      organization_id: input.organizationId,
      bot_job_id: input.botJobId ?? null,
      event_type: input.eventType,
      source: input.source,
      payload: (input.payload ?? {}) as never,
    });
  if (error) throw error;
}

/**
 * M5 decides whether a meeting is joinable; this decides whether a bot
 * *intent* should exist for it — one call, fully idempotent, safe to
 * call repeatedly for the same meeting from any number of callers.
 *
 * Deliberately NOT hooked into evaluateMeetingPolicy's own write path
 * (packages/domain/src/meeting-policy.ts) — same reasoning Codex gave for
 * M5 not hooking into M4's upsertCanonicalMeeting: coupling a milestone's
 * write path to the NEXT milestone's side effect is coupling without much
 * payoff. reconcileOrganizationMeetingBots below scans meetings by their
 * CURRENT state instead, exactly like evaluateOrganizationMeetings scans
 * by lifecycle_status. This is also why M6 needed no edits to any M5 file.
 */
export async function syncMeetingBotIntent(
  serviceRoleClient: AppSupabaseClient,
  provider: MeetingBotProvider,
  meetingId: string,
): Promise<void> {
  const { data: meeting, error } = await serviceRoleClient
    .from("meetings")
    .select(
      "id, organization_id, meeting_url, eligibility_status, lifecycle_status",
    )
    .eq("id", meetingId)
    .single();
  if (error) throw error;

  const { data: liveJob, error: liveJobError } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select("id, status, generation, provider_bot_id")
    .eq("meeting_id", meetingId)
    .eq("organization_id", meeting.organization_id)
    .not("status", "in", LIVE_FILTER)
    .maybeSingle();
  if (liveJobError) throw liveJobError;

  const shouldHaveLiveBot =
    meeting.eligibility_status === "record" &&
    meeting.lifecycle_status === "upcoming";

  if (shouldHaveLiveBot) {
    if (liveJob) return; // already has a live attempt — nothing to do
    if (!meeting.meeting_url) return; // can't schedule without a join URL

    const { data: maxGenRow, error: maxGenError } = await serviceRoleClient
      .from("meeting_bot_jobs")
      .select("generation")
      .eq("meeting_id", meetingId)
      .eq("organization_id", meeting.organization_id)
      .order("generation", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxGenError) throw maxGenError;
    const generation = (maxGenRow?.generation ?? 0) + 1;

    const { data: inserted, error: insertError } = await serviceRoleClient
      .from("meeting_bot_jobs")
      .insert({
        meeting_id: meetingId,
        organization_id: meeting.organization_id,
        status: "pending",
        generation,
        idempotency_key: `${meetingId}:${generation}`,
      })
      .select("id")
      .single();
    if (insertError) {
      // 23505 on the one-live-per-meeting index means a concurrent caller
      // already created the live row — that IS the idempotency guarantee
      // working, not a real error.
      if ((insertError as { code?: string }).code === "23505") return;
      throw insertError;
    }

    await logLifecycleEvent(serviceRoleClient, {
      meetingId,
      organizationId: meeting.organization_id,
      botJobId: inserted.id,
      eventType: "bot_intent.created",
      source: "reconcile",
    });
    return;
  }

  // Not eligible (or no longer upcoming) — cancel a live bot that hasn't
  // actually joined yet (pending/scheduled/joining). An already-'joined'
  // bot is left alone: it will complete naturally rather than being
  // silently pulled out of a meeting it's already in.
  if (!liveJob) return;
  if (liveJob.status === "joined") return;

  // Codex's M6 final review caught a real race here: `liveJob` is a
  // snapshot that can go stale between reading it and writing the
  // cancellation — processPendingBotJobs could be claiming/scheduling
  // the same row concurrently, or syncBotStatuses could be marking it
  // 'joined', right now. Guarding the UPDATE with the EXACT status we
  // observed makes this a real compare-and-swap: it only takes effect if
  // nothing else has moved the row since. If we lose the race, there is
  // nothing to cancel — either it's now further along (possibly
  // 'joined', which must never be touched) or already terminal — and the
  // next reconcile tick re-reads the current state fresh and corrects it
  // (TRD: "reconciliation protects correctness"), rather than risking
  // silently overwriting a state we no longer have accurate knowledge of.
  const { data: claimedForCancel, error: cancelClaimError } =
    await serviceRoleClient
      .from("meeting_bot_jobs")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", liveJob.id)
      .eq("organization_id", meeting.organization_id)
      .eq("status", liveJob.status)
      .select("id")
      .maybeSingle();
  if (cancelClaimError) throw cancelClaimError;
  if (!claimedForCancel) return;

  if (liveJob.provider_bot_id) {
    try {
      await provider.cancelBot({ providerBotId: liveJob.provider_bot_id });
    } catch (cancelError) {
      // Don't let a transient provider error undo the DB-side cancellation
      // we already committed — reconciliation/status polling catches a
      // bot that's still live on the provider's side despite this call
      // failing (TRD: "reconciliation protects correctness").
      await logLifecycleEvent(serviceRoleClient, {
        meetingId,
        organizationId: meeting.organization_id,
        botJobId: liveJob.id,
        eventType: "bot.cancel_call_failed",
        source: "reconcile",
        payload: {
          error:
            cancelError instanceof Error
              ? cancelError.message
              : String(cancelError),
        },
      });
    }
  }

  await logLifecycleEvent(serviceRoleClient, {
    meetingId,
    organizationId: meeting.organization_id,
    botJobId: liveJob.id,
    eventType: "bot_intent.cancelled",
    source: "reconcile",
  });
}

export interface ReconcileResult {
  meetingsScanned: number;
}

/** Callable on demand via an internal route — same shape as M5's evaluateOrganizationMeetings. */
export async function reconcileOrganizationMeetingBots(
  serviceRoleClient: AppSupabaseClient,
  provider: MeetingBotProvider,
  organizationId: string,
): Promise<ReconcileResult> {
  const { data: meetings, error } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("organization_id", organizationId)
    .in("lifecycle_status", ["upcoming", "cancelled"]);
  if (error) throw error;

  for (const meeting of meetings ?? []) {
    await syncMeetingBotIntent(serviceRoleClient, provider, meeting.id);
  }

  return { meetingsScanned: meetings?.length ?? 0 };
}

export interface ProcessPendingResult {
  scheduled: number;
  failed: number;
}

/**
 * The actual provider side effect — deliberately separate from
 * syncMeetingBotIntent (which only ever touches our own DB). This is the
 * "durable job/worker" step: safe to run from workers/orchestrator on a
 * timer, or on demand via /api/internal/meeting-bots/process, and safe to
 * run concurrently from more than one worker instance — the optimistic
 * claim below (matching retry_count in the WHERE clause) guarantees only
 * one caller's update actually claims a given row, so two workers can
 * never both call provider.createBot for the same job.
 */
export async function processPendingBotJobs(
  serviceRoleClient: AppSupabaseClient,
  provider: MeetingBotProvider,
  limit = 10,
): Promise<ProcessPendingResult> {
  const { data: jobs, error } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select("id, meeting_id, organization_id, idempotency_key, retry_count")
    .eq("status", "pending")
    .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  let scheduled = 0;
  let failed = 0;

  if (!jobs || jobs.length === 0) return { scheduled, failed };

  // M17C dispatch timing gate. Two small, separate lookups rather than
  // one embedded join — keeps the existing jobs query above completely
  // untouched, and each pending job can belong to a different org with a
  // different configured lead time, which a single per-row constant
  // filter can't express anyway. The `limit` above already bounds how
  // many jobs (and therefore how many meetings) this fetches per call —
  // the real "is it actually due yet" decision happens per-job below,
  // against the org's real configured lead time.
  const meetingIds = Array.from(new Set(jobs.map((j) => j.meeting_id)));
  const organizationIds = Array.from(
    new Set(jobs.map((j) => j.organization_id)),
  );

  const { data: meetingTimings, error: timingsError } = await serviceRoleClient
    .from("meetings")
    .select("id, scheduled_start, scheduled_end")
    .in("id", meetingIds);
  if (timingsError) throw timingsError;
  const timingByMeetingId = new Map(
    (meetingTimings ?? []).map((m) => [m.id, m]),
  );

  const { data: policySets, error: policySetsError } = await serviceRoleClient
    .from("meeting_policy_sets")
    .select("organization_id, bot_dispatch_lead_seconds")
    .in("organization_id", organizationIds);
  if (policySetsError) throw policySetsError;
  const leadSecondsByOrg = new Map(
    (policySets ?? []).map((p) => [p.organization_id, p.bot_dispatch_lead_seconds]),
  );

  for (const job of jobs) {
    // Defensive only — meeting_bot_jobs.meeting_id is a real FK, so a
    // real job's meeting always exists. Fail closed (skip, don't
    // dispatch) rather than guess if the lookup above somehow missed it.
    const timing = timingByMeetingId.get(job.meeting_id);
    if (!timing) continue;

    const leadSeconds =
      leadSecondsByOrg.get(job.organization_id) ??
      DEFAULT_BOT_DISPATCH_LEAD_SECONDS;
    const dispatchAtMs =
      new Date(timing.scheduled_start).getTime() - leadSeconds * 1000;
    if (Date.now() < dispatchAtMs) continue; // not due yet — row untouched, next tick re-checks

    // THE exclusive claim (Codex's M6 final review caught a real gap
    // here): this must flip status OUT of 'pending' atomically, not just
    // bump retry_count while leaving status='pending' — the old version
    // left a window, for as long as provider.createBot() below is in
    // flight, where a second independent poll (another worker process,
    // or the next tick) could re-select this same still-'pending' row,
    // read the already-incremented retry_count fresh, and successfully
    // re-claim it too, calling the provider a second time for the same
    // job. Flipping to 'scheduled' here means any concurrent claim
    // attempt's `.eq("status","pending")` no longer matches at all.
    const { data: claimed, error: claimError } = await serviceRoleClient
      .from("meeting_bot_jobs")
      .update({ status: "scheduled", retry_count: job.retry_count + 1 })
      .eq("id", job.id)
      .eq("organization_id", job.organization_id)
      .eq("status", "pending")
      .eq("retry_count", job.retry_count)
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) continue; // another caller claimed this row first

    // Late-discovery bound: a meeting found (or still pending) well after
    // it already ended has nothing left to record — dispatching into it
    // is pure cost, not a useful catch-up. Guarded by status='scheduled'
    // (what we just claimed it to), same reasoning as every other
    // transition here.
    if (Date.now() > new Date(timing.scheduled_end).getTime() + LATE_DISCOVERY_GRACE_MS) {
      await serviceRoleClient
        .from("meeting_bot_jobs")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          last_error: "Meeting ended before the bot could be dispatched.",
        })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("status", "scheduled");
      failed += 1;
      continue;
    }

    const { data: meeting, error: meetingError } = await serviceRoleClient
      .from("meetings")
      .select("meeting_url")
      .eq("id", job.meeting_id)
      .eq("organization_id", job.organization_id)
      .single();
    if (meetingError) throw meetingError;

    if (!meeting.meeting_url) {
      // Guarded by status='scheduled' (what we just claimed it to) for
      // the same reason as every other transition here: don't stomp a
      // 'cancelled' row if syncMeetingBotIntent raced in in the meantime.
      await serviceRoleClient
        .from("meeting_bot_jobs")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          last_error: "Meeting has no join URL.",
        })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("status", "scheduled");
      failed += 1;
      continue;
    }

    try {
      const result = await provider.createBot({
        meetingUrl: meeting.meeting_url,
        idempotencyKey: job.idempotency_key,
        botName: BOT_NAME,
      });

      // Confirm the real provider bot onto the row we claimed — guarded
      // by status='scheduled' still, in case syncMeetingBotIntent
      // cancelled this exact job while the provider call was in flight.
      const { data: confirmed, error: updateError } = await serviceRoleClient
        .from("meeting_bot_jobs")
        .update({
          provider_bot_id: result.providerBotId,
          scheduled_at: new Date().toISOString(),
          provider_metadata: result.raw as never,
        })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("status", "scheduled")
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;

      if (!confirmed) {
        // The meeting became ineligible and syncMeetingBotIntent already
        // marked this job 'cancelled' while createBot() was in flight —
        // the provider now thinks a bot is live for a meeting we no
        // longer want captured. Cancel it immediately rather than
        // leaving it orphaned; don't touch our own (already-cancelled)
        // row again.
        try {
          await provider.cancelBot({ providerBotId: result.providerBotId });
        } catch (cancelError) {
          await logLifecycleEvent(serviceRoleClient, {
            meetingId: job.meeting_id,
            organizationId: job.organization_id,
            botJobId: job.id,
            eventType: "bot.cancel_call_failed",
            source: "worker",
            payload: {
              error:
                cancelError instanceof Error
                  ? cancelError.message
                  : String(cancelError),
            },
          });
        }
        continue;
      }

      await logLifecycleEvent(serviceRoleClient, {
        meetingId: job.meeting_id,
        organizationId: job.organization_id,
        botJobId: job.id,
        eventType: "bot.scheduled",
        source: "worker",
        payload: { providerBotId: result.providerBotId },
      });
      scheduled += 1;
    } catch (createError) {
      const message =
        createError instanceof Error
          ? createError.message
          : String(createError);
      const retryAfterSeconds = extractRetryAfterSeconds(createError);

      if (retryAfterSeconds !== null) {
        // A rate-limit-shaped error (duck-typed on retryAfterSeconds, not
        // a Vexa-specific type — keeps this provider-agnostic) is
        // transient: go back to 'pending' for a later tick to retry,
        // rather than burning the job on a failure that wasn't really
        // ours or the meeting's fault. retry_count already reflects this
        // attempt from the claim above.
        await serviceRoleClient
          .from("meeting_bot_jobs")
          .update({
            status: "pending",
            next_retry_at: new Date(
              Date.now() + retryAfterSeconds * 1000,
            ).toISOString(),
            last_error: message,
          })
          .eq("id", job.id)
          .eq("organization_id", job.organization_id)
          .eq("status", "scheduled");
        await logLifecycleEvent(serviceRoleClient, {
          meetingId: job.meeting_id,
          organizationId: job.organization_id,
          botJobId: job.id,
          eventType: "bot.schedule_retry_scheduled",
          source: "worker",
          payload: { error: message, retryAfterSeconds },
        });
        continue;
      }

      await serviceRoleClient
        .from("meeting_bot_jobs")
        .update({
          status: "failed",
          failed_at: new Date().toISOString(),
          last_error: message,
        })
        .eq("id", job.id)
        .eq("organization_id", job.organization_id)
        .eq("status", "scheduled");
      await logLifecycleEvent(serviceRoleClient, {
        meetingId: job.meeting_id,
        organizationId: job.organization_id,
        botJobId: job.id,
        eventType: "bot.schedule_failed",
        source: "worker",
        payload: { error: message },
      });
      failed += 1;
    }
  }

  return { scheduled, failed };
}

/** Duck-typed, not a Vexa-specific import — any provider's rate-limit error shaped this way gets retried instead of failed. */
function extractRetryAfterSeconds(error: unknown): number | null {
  if (error && typeof error === "object" && "retryAfterSeconds" in error) {
    const value = (error as { retryAfterSeconds: unknown }).retryAfterSeconds;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export interface SyncStatusesResult {
  updated: number;
}

/**
 * Polls the provider for jobs we believe are still live and reconciles
 * our own status against it — the local/no-public-URL substitute for a
 * real Vexa webhook receiver (POST /api/webhooks/vexa is the locked
 * blueprint's eventual design; a webhook needs a publicly reachable URL,
 * which isn't available in local dev — polling is the deliberate V1
 * fallback, not a placeholder for "never built").
 */
export async function syncBotStatuses(
  serviceRoleClient: AppSupabaseClient,
  provider: MeetingBotProvider,
  limit = 20,
): Promise<SyncStatusesResult> {
  const { data: jobs, error } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select(
      "id, meeting_id, organization_id, provider_bot_id, status, scheduled_at",
    )
    .in("status", ["scheduled", "joining", "joined"])
    .not("provider_bot_id", "is", null)
    .limit(limit);
  if (error) throw error;

  let updated = 0;

  for (const job of jobs ?? []) {
    const result = await provider.getBotStatus(job.provider_bot_id as string);
    if (result.status === job.status) continue;

    // Codex's M6 final review caught a real race: processPendingBotJobs and
    // syncBotStatuses run in the SAME tick, so a bot that was just created
    // may not have propagated into the provider's own "running" list yet —
    // getBotStatus's "not found ⇒ completed" fallback would then mark a
    // brand-new bot terminal immediately, and the next tick would create a
    // duplicate (completed is terminal, so syncMeetingBotIntent would see
    // no live job for a still-upcoming 'record' meeting). A job that has
    // never been CONFIRMED live (still 'scheduled', never seen 'joining'/
    // 'joined') needs a grace period before "not found" is trusted —
    // 'joining'/'joined' → 'completed' has no such risk, since those only
    // happen after the provider already confirmed the bot was real.
    if (job.status === "scheduled" && result.status === "completed") {
      const scheduledAt = job.scheduled_at
        ? new Date(job.scheduled_at).getTime()
        : 0;
      const graceMs = 2 * 60 * 1000;
      if (Date.now() - scheduledAt < graceMs) continue;
    }

    const update: Record<string, unknown> = { status: result.status };
    if (result.status === "joined" && result.joinedAt)
      update.joined_at = result.joinedAt;
    if (result.status === "completed") {
      if (result.leftAt) update.left_at = result.leftAt;
    }
    if (result.status === "failed") {
      update.failed_at = new Date().toISOString();
      update.last_error =
        result.failureReason ?? "Provider reported the bot failed.";
    }

    // Guarded by the exact status we just read (and org-scoped), same
    // compare-and-swap reasoning as everywhere else in this file — if
    // syncMeetingBotIntent cancelled this job in the meantime, this
    // provider-status update loses the race and correctly no-ops rather
    // than reviving a row that was just intentionally cancelled.
    const { data: confirmed, error: updateError } = await serviceRoleClient
      .from("meeting_bot_jobs")
      .update(update as never)
      .eq("id", job.id)
      .eq("organization_id", job.organization_id)
      .eq("status", job.status)
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!confirmed) continue;

    await logLifecycleEvent(serviceRoleClient, {
      meetingId: job.meeting_id,
      organizationId: job.organization_id,
      botJobId: job.id,
      eventType: `bot.status_changed.${result.status}`,
      source: "worker",
    });
    updated += 1;
  }

  return { updated };
}
