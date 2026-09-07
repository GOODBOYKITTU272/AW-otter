import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import { getCalendarEvent, isTeamsEvent, listUpcomingEvents, type MicrosoftCalendarEvent } from "@applywizz/microsoft";
import { getValidAccessToken, type MicrosoftEnv } from "./microsoft-connection";

export type AppSupabaseClient = SupabaseClient<Database>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export interface UpsertMeetingInput {
  organizationId: string;
  ownerMembershipId: string;
  provider: string;
  event: MicrosoftCalendarEvent;
}

/**
 * The single place a Microsoft calendar event becomes (or updates) a
 * canonical meeting row. Used by both the queue processor (one event at a
 * time) and reconciliation (a full listing) so the two paths can never
 * disagree about what a "meeting" looks like. Always writes
 * eligibility_status as the column default ('pending') — M4 never sets it
 * to anything else; deciding record/exclude is M5's job.
 *
 * Attendees are replaced wholesale on every call (delete + reinsert) —
 * no attendance history is tracked yet, matching M4's scope.
 */
export async function upsertCanonicalMeeting(
  serviceRoleClient: AppSupabaseClient,
  input: UpsertMeetingInput,
): Promise<{ meetingId: string }> {
  const { data: existing, error: existingError } = await serviceRoleClient
    .from("meetings")
    .select("scheduled_start, scheduled_end")
    .eq("organization_id", input.organizationId)
    .eq("provider", input.provider)
    .eq("external_event_id", input.event.externalEventId)
    .maybeSingle();
  if (existingError) throw existingError;

  // Reflects whether THIS sync changed the time, not lifetime history — the
  // next unchanged sync clears it. A full change history is out of scope.
  const rescheduled =
    existing !== null &&
    (new Date(existing.scheduled_start).getTime() !== new Date(input.event.start).getTime() ||
      new Date(existing.scheduled_end).getTime() !== new Date(input.event.end).getTime());

  const { data: meeting, error } = await serviceRoleClient
    .from("meetings")
    .upsert(
      {
        organization_id: input.organizationId,
        owner_membership_id: input.ownerMembershipId,
        provider: input.provider,
        external_event_id: input.event.externalEventId,
        meeting_url: input.event.joinUrl,
        title: input.event.subject,
        organizer_name: input.event.organizer.name,
        organizer_email: input.event.organizer.email,
        meeting_type: isTeamsEvent(input.event) ? "teams" : null,
        scheduled_start: input.event.start,
        scheduled_end: input.event.end,
        lifecycle_status: "upcoming",
        reason_code: rescheduled ? "rescheduled" : null,
      },
      { onConflict: "organization_id,provider,external_event_id" },
    )
    .select()
    .single();
  if (error) throw error;

  const { error: deleteError } = await serviceRoleClient
    .from("meeting_attendees")
    .delete()
    .eq("meeting_id", meeting.id);
  if (deleteError) throw deleteError;

  if (input.event.attendees.length > 0) {
    const { error: insertError } = await serviceRoleClient.from("meeting_attendees").insert(
      input.event.attendees.map((attendee) => ({
        meeting_id: meeting.id,
        email: attendee.email,
        display_name: attendee.name,
      })),
    );
    if (insertError) throw insertError;
  }

  return { meetingId: meeting.id };
}

/** No-op if we never had this meeting on file — out-of-order deletes are normal. */
export async function cancelCanonicalMeeting(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  provider: string,
  externalEventId: string,
): Promise<{ found: boolean }> {
  const { data, error } = await serviceRoleClient
    .from("meetings")
    .update({ lifecycle_status: "cancelled" })
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("external_event_id", externalEventId)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return { found: data !== null };
}

export interface EnqueueCalendarEventJobInput {
  calendarConnectionId: string;
  organizationId: string;
  provider: string;
  externalEventId: string;
  changeType: string;
}

/**
 * Fast, no-Graph-calls-here handoff — called from the webhook (and from
 * reconciliation, for anything it wants processed the same way as a live
 * notification). Duplicate notifications for the same
 * (connection, event, change) while a job is still pending/processing
 * collapse into one row via the DB's partial unique index — this just
 * treats that as success, not an error.
 */
export async function enqueueCalendarEventJob(
  serviceRoleClient: AppSupabaseClient,
  input: EnqueueCalendarEventJobInput,
): Promise<void> {
  const { error } = await serviceRoleClient.from("calendar_event_jobs").insert({
    calendar_connection_id: input.calendarConnectionId,
    organization_id: input.organizationId,
    provider: input.provider,
    external_event_id: input.externalEventId,
    change_type: input.changeType,
  });
  if (error && error.code !== "23505") throw error;
}

/**
 * The webhook only knows Graph's subscriptionId — never trust an org/
 * membership id from the notification payload itself. Resolves it back to
 * OUR stored connection/org via provider_subscriptions, then enqueues.
 * No-ops (returns false) for a subscription id we don't recognize, e.g. a
 * stale/already-deleted subscription still delivering in-flight notifications.
 */
export async function enqueueCalendarEventJobForSubscription(
  serviceRoleClient: AppSupabaseClient,
  input: { externalSubscriptionId: string; externalEventId: string; changeType: string },
): Promise<boolean> {
  const { data: subscription, error: subscriptionError } = await serviceRoleClient
    .from("provider_subscriptions")
    .select("calendar_connection_id, provider")
    .eq("external_subscription_id", input.externalSubscriptionId)
    .maybeSingle();
  if (subscriptionError) throw subscriptionError;
  if (!subscription) return false;

  const { data: connection, error: connectionError } = await serviceRoleClient
    .from("calendar_connections")
    .select("organization_membership_id")
    .eq("id", subscription.calendar_connection_id)
    .single();
  if (connectionError) throw connectionError;

  const { data: membership, error: membershipError } = await serviceRoleClient
    .from("organization_memberships")
    .select("organization_id")
    .eq("id", connection.organization_membership_id)
    .single();
  if (membershipError) throw membershipError;

  await enqueueCalendarEventJob(serviceRoleClient, {
    calendarConnectionId: subscription.calendar_connection_id,
    organizationId: membership.organization_id,
    provider: subscription.provider,
    externalEventId: input.externalEventId,
    changeType: input.changeType,
  });
  return true;
}

async function processOneJob(
  serviceRoleClient: AppSupabaseClient,
  job: Database["public"]["Tables"]["calendar_event_jobs"]["Row"],
  microsoftEnv: MicrosoftEnv,
  encryptionKey: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const { data: connection, error: connectionError } = await serviceRoleClient
    .from("calendar_connections")
    .select("organization_membership_id")
    .eq("id", job.calendar_connection_id)
    .single();
  if (connectionError) throw connectionError;

  if (job.change_type === "deleted") {
    await cancelCanonicalMeeting(serviceRoleClient, job.organization_id, job.provider, job.external_event_id);
    return;
  }

  const accessToken = await getValidAccessToken(
    serviceRoleClient,
    job.calendar_connection_id,
    microsoftEnv,
    encryptionKey,
    fetchImpl,
  );

  const event = await getCalendarEvent(accessToken, job.external_event_id, fetchImpl);
  if (!event) {
    // The event is gone by the time we fetched it (deleted between
    // notification and processing, or a stale/out-of-order notification).
    // cancelCanonicalMeeting no-ops if we never had it — safe either way.
    await cancelCanonicalMeeting(serviceRoleClient, job.organization_id, job.provider, job.external_event_id);
    return;
  }

  await upsertCanonicalMeeting(serviceRoleClient, {
    organizationId: job.organization_id,
    ownerMembershipId: connection.organization_membership_id,
    provider: job.provider,
    event,
  });
}

export interface ProcessQueueOptions {
  microsoftEnv: MicrosoftEnv;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
  /** Bounded batch per call — this is an internal route, not an always-on worker (M4 scope; see M16 for real worker infra). */
  maxJobs?: number;
  maxAttempts?: number;
}

export interface ProcessQueueResult {
  processed: number;
  succeeded: number;
  retried: number;
  deadLettered: number;
}

const BACKOFF_BASE_MS = 30_000;

/** Exponential backoff, capped, jittered enough to avoid a thundering herd of retries. */
function nextRunAt(attempts: number): string {
  const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** attempts, 30 * 60 * 1000);
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Drains up to maxJobs pending jobs, one atomic claim
 * (claim_next_calendar_event_job, FOR UPDATE SKIP LOCKED) at a time.
 * Called from an internal, service-role-only route — not a persistent
 * poller (deliberately deferred, see packages/domain/src/meetings.ts
 * module doc / the M4 report).
 */
export async function processCalendarEventQueue(
  serviceRoleClient: AppSupabaseClient,
  options: ProcessQueueOptions,
): Promise<ProcessQueueResult> {
  const maxJobs = options.maxJobs ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;
  const result: ProcessQueueResult = { processed: 0, succeeded: 0, retried: 0, deadLettered: 0 };

  for (let i = 0; i < maxJobs; i += 1) {
    const { data: job, error: claimError } = await serviceRoleClient.rpc("claim_next_calendar_event_job");
    if (claimError) throw claimError;
    // PostgREST serializes this function's "no job" case (a composite-NULL
    // row) as an object with every field null, NOT JSON null — job.id is
    // the only reliable emptiness check.
    if (!job?.id) break;

    result.processed += 1;

    try {
      await processOneJob(serviceRoleClient, job, options.microsoftEnv, options.encryptionKey, options.fetchImpl);
      const { error: completeError } = await serviceRoleClient
        .from("calendar_event_jobs")
        .update({ status: "completed" })
        .eq("id", job.id);
      if (completeError) throw completeError;
      result.succeeded += 1;
    } catch (error) {
      const attempts = job.attempts + 1;
      const message = errorMessage(error);

      if (attempts >= maxAttempts) {
        await serviceRoleClient
          .from("calendar_event_jobs")
          .update({ status: "dead_letter", attempts, last_error: message })
          .eq("id", job.id);
        result.deadLettered += 1;
      } else {
        await serviceRoleClient
          .from("calendar_event_jobs")
          .update({ status: "pending", attempts, last_error: message, run_at: nextRunAt(attempts) })
          .eq("id", job.id);
        result.retried += 1;
      }
    }
  }

  return result;
}

export interface ReconcileConnectionInput {
  connectionId: string;
  organizationId: string;
  ownerMembershipId: string;
  provider: string;
  microsoftEnv: MicrosoftEnv;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
}

export interface ReconcileConnectionResult {
  eventsSeen: number;
  cancelled: number;
  ranAt: string;
}

/**
 * Catches what a missed/failed webhook would otherwise leave stale: fetch
 * the current upcoming-events list fresh, upsert everything in it (using
 * the exact same upsertCanonicalMeeting the queue processor uses), then
 * cancel any 'upcoming' meeting for this owner that's no longer in the
 * list. Not scheduled in M4 (no cron yet) — callable on demand, same as
 * subscription renewal in M3.
 */
export async function reconcileCalendarConnection(
  serviceRoleClient: AppSupabaseClient,
  input: ReconcileConnectionInput,
): Promise<ReconcileConnectionResult> {
  const accessToken = await getValidAccessToken(
    serviceRoleClient,
    input.connectionId,
    input.microsoftEnv,
    input.encryptionKey,
    input.fetchImpl,
  );
  const events = await listUpcomingEvents(accessToken, input.fetchImpl);

  for (const event of events) {
    await upsertCanonicalMeeting(serviceRoleClient, {
      organizationId: input.organizationId,
      ownerMembershipId: input.ownerMembershipId,
      provider: input.provider,
      event,
    });
  }

  const seenExternalIds = new Set(events.map((event) => event.externalEventId));

  const { data: staleMeetings, error } = await serviceRoleClient
    .from("meetings")
    .select("id, external_event_id")
    .eq("organization_id", input.organizationId)
    .eq("owner_membership_id", input.ownerMembershipId)
    .eq("provider", input.provider)
    .eq("lifecycle_status", "upcoming")
    .gte("scheduled_start", new Date().toISOString());
  if (error) throw error;

  const stale = (staleMeetings ?? []).filter((meeting) => !seenExternalIds.has(meeting.external_event_id));
  for (const meeting of stale) {
    const { error: cancelError } = await serviceRoleClient
      .from("meetings")
      .update({ lifecycle_status: "cancelled" })
      .eq("id", meeting.id);
    if (cancelError) throw cancelError;
  }

  const result: ReconcileConnectionResult = {
    eventsSeen: events.length,
    cancelled: stale.length,
    ranAt: new Date().toISOString(),
  };

  // Only written on success — a failed run (e.g. token refresh failing)
  // leaves the previous result in place rather than fabricating one.
  const { error: persistError } = await serviceRoleClient
    .from("calendar_connections")
    .update({ last_reconciliation_result: result as unknown as Json })
    .eq("id", input.connectionId);
  if (persistError) throw persistError;

  return result;
}
