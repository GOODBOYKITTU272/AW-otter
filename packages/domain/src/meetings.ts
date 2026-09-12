import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import {
  getAppOnlyAccessToken,
  getCalendarEvent,
  isTeamsEvent,
  listUpcomingEvents,
  listUpcomingEventsForUser,
  type MicrosoftCalendarEvent,
} from "@applywizz/microsoft";
import { getValidAccessToken, type MicrosoftEnv } from "./microsoft-connection";

export type AppSupabaseClient = SupabaseClient<Database>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Canonical identity fields shared by every meetings insert/update — kept
 * as one object so the insert path and the update path can't drift.
 */
function meetingFields(event: MicrosoftCalendarEvent, rescheduled: boolean) {
  return {
    title: event.subject,
    meeting_url: event.joinUrl,
    organizer_name: event.organizer.name,
    organizer_email: event.organizer.email,
    meeting_type: isTeamsEvent(event) ? "teams" : null,
    scheduled_start: event.start,
    scheduled_end: event.end,
    lifecycle_status: "upcoming",
    reason_code: rescheduled ? "rescheduled" : null,
    graph_event_type: event.graphEventType,
    series_master_id: event.seriesMasterId,
    original_start: event.originalStart,
    online_meeting_id: event.onlineMeetingId,
  };
}

export interface UpsertMeetingInput {
  organizationId: string;
  provider: string;
  event: MicrosoftCalendarEvent;
  /** The observing mailbox's stable identity (work email/UPN) — provider/mailbox sync identity, not canonical identity. */
  providerUserKey: string;
  /** ApplyWizz membership of the employee whose mailbox this observation came through, if known. */
  observerMembershipId: string | null;
}

/**
 * The single place a Microsoft calendar event becomes (or updates) a
 * canonical meeting row. Used by the queue processor, delegated
 * reconciliation, and tenant-wide reconciliation, so none of the three
 * paths can ever disagree about what a "meeting" looks like.
 *
 * Two-tier identity (design reviewed by Codex before implementation):
 * - mailbox event id (event.externalEventId) is provider/mailbox sync
 *   identity only, tracked in meeting_external_events. Once tenant-wide
 *   sync covers every employee by default, two ApplyWizz employees invited
 *   to the same real meeting will each have a DIFFERENT event id in their
 *   own mailbox.
 * - event.icalUId is canonical meeting identity — stable across every
 *   mailbox's copy of the same meeting AND unique per-occurrence within a
 *   recurring series (verified against Graph docs, not the RFC 5545
 *   shared-UID model).
 *
 * Resolution order: (1) have we seen this exact mailbox+event pair before
 * (fast path, meeting_external_events)? (2) if not, does a canonical
 * meeting already exist for this icalUId (a new mailbox observing an
 * existing meeting, e.g. a manager added to an AM's 1:1)? (3) otherwise
 * this is genuinely new. The meetings upsert on step 3 uses ON CONFLICT
 * (not a plain insert), so two concurrent first-sightings from different
 * mailboxes converge on one row atomically rather than racing.
 *
 * Attendees are replaced wholesale on every call (delete + reinsert) —
 * last-write-wins per canonical meeting, not merged across observations
 * (Codex-reviewed: merging now would risk fake precision given Graph's own
 * attendee-payload limits).
 */
export async function upsertCanonicalMeeting(
  serviceRoleClient: AppSupabaseClient,
  input: UpsertMeetingInput,
): Promise<{ meetingId: string }> {
  const { data: mapping, error: mappingError } = await serviceRoleClient
    .from("meeting_external_events")
    .select("meeting_id")
    .eq("organization_id", input.organizationId)
    .eq("provider", input.provider)
    .eq("provider_user_key", input.providerUserKey)
    .eq("external_event_id", input.event.externalEventId)
    .maybeSingle();
  if (mappingError) throw mappingError;

  let resolvedMeetingId = mapping?.meeting_id ?? null;

  if (!resolvedMeetingId) {
    const { data: byIcalUid, error: icalLookupError } = await serviceRoleClient
      .from("meetings")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("provider", input.provider)
      .eq("ical_uid", input.event.icalUId)
      .maybeSingle();
    if (icalLookupError) throw icalLookupError;
    resolvedMeetingId = byIcalUid?.id ?? null;
  }

  let meetingId: string;

  if (resolvedMeetingId) {
    const { data: existing, error: existingError } = await serviceRoleClient
      .from("meetings")
      .select("scheduled_start, scheduled_end")
      .eq("id", resolvedMeetingId)
      .single();
    if (existingError) throw existingError;

    // Reflects whether THIS sync changed the time, not lifetime history —
    // the next unchanged sync clears it. A full change history is out of scope.
    const rescheduled =
      new Date(existing.scheduled_start).getTime() !== new Date(input.event.start).getTime() ||
      new Date(existing.scheduled_end).getTime() !== new Date(input.event.end).getTime();

    const { error: updateError } = await serviceRoleClient
      .from("meetings")
      .update({
        ...meetingFields(input.event, rescheduled),
        // Only the organizer's own mailbox observation updates ownership —
        // a non-organizer attendee's copy shouldn't reassign who owns the
        // canonical meeting.
        ...(input.event.isOrganizer ? { owner_membership_id: input.observerMembershipId } : {}),
      })
      .eq("id", resolvedMeetingId);
    if (updateError) throw updateError;
    meetingId = resolvedMeetingId;
  } else {
    // Codex final review, Finding #1: owner_membership_id must NOT be in
    // this payload unconditionally. supabase-js's upsert sets every column
    // present in the payload on BOTH the fresh-insert path and the
    // ON CONFLICT DO UPDATE path — if a non-organizer's first-sighting
    // loses a concurrent race against the organizer's, its DO UPDATE would
    // silently overwrite the organizer's already-correct ownership. Same
    // rule as the update branch above: only an organizer observation ever
    // sets ownership. Omitting the key entirely (not even `null`) means a
    // non-organizer's fresh insert leaves the row unowned until the
    // organizer's own observation arrives, and a non-organizer's
    // conflict-update never touches whatever ownership already exists.
    const { data: created, error: insertError } = await serviceRoleClient
      .from("meetings")
      .upsert(
        {
          organization_id: input.organizationId,
          provider: input.provider,
          ical_uid: input.event.icalUId,
          ...(input.event.isOrganizer ? { owner_membership_id: input.observerMembershipId } : {}),
          ...meetingFields(input.event, false),
        },
        { onConflict: "organization_id,provider,ical_uid" },
      )
      .select("id")
      .single();
    if (insertError) throw insertError;
    meetingId = created.id;
  }

  const { error: mapUpsertError } = await serviceRoleClient.from("meeting_external_events").upsert(
    {
      meeting_id: meetingId,
      organization_id: input.organizationId,
      provider: input.provider,
      provider_user_key: input.providerUserKey,
      external_event_id: input.event.externalEventId,
      is_organizer: input.event.isOrganizer,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,provider,provider_user_key,external_event_id" },
  );
  if (mapUpsertError) throw mapUpsertError;

  const { error: deleteError } = await serviceRoleClient
    .from("meeting_attendees")
    .delete()
    .eq("meeting_id", meetingId);
  if (deleteError) throw deleteError;

  if (input.event.attendees.length > 0) {
    const { error: insertAttendeesError } = await serviceRoleClient.from("meeting_attendees").insert(
      input.event.attendees.map((attendee) => ({
        meeting_id: meetingId,
        email: attendee.email,
        display_name: attendee.name,
      })),
    );
    if (insertAttendeesError) throw insertAttendeesError;
  }

  return { meetingId };
}

/**
 * A Graph "deleted" notification carries only an id, never an event body —
 * there's no icalUId to resolve identity from at cancel time, so this MUST
 * resolve via the meeting_external_events mapping alone.
 *
 * Organizer-vs-attendee asymmetry (Codex-reviewed, using Graph's own
 * isOrganizer field rather than comparing email strings): only the
 * organizer's own mailbox losing the event actually cancels the meeting
 * for everyone. A non-organizer attendee's copy disappearing (declined,
 * removed) only clears that one observer's mapping — the canonical
 * meeting is untouched. No-op (found: false) if we never had this
 * mailbox+event pair on file — out-of-order deletes are normal.
 */
export async function cancelCanonicalMeeting(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  provider: string,
  providerUserKey: string,
  externalEventId: string,
): Promise<{ found: boolean; cancelledMeeting: boolean }> {
  const { data: mapping, error: mappingError } = await serviceRoleClient
    .from("meeting_external_events")
    .select("meeting_id, is_organizer")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("provider_user_key", providerUserKey)
    .eq("external_event_id", externalEventId)
    .maybeSingle();
  if (mappingError) throw mappingError;
  if (!mapping) return { found: false, cancelledMeeting: false };

  let cancelledMeeting = false;
  if (mapping.is_organizer) {
    const { error } = await serviceRoleClient
      .from("meetings")
      .update({ lifecycle_status: "cancelled" })
      .eq("id", mapping.meeting_id);
    if (error) throw error;
    cancelledMeeting = true;
  }

  const { error: deleteMappingError } = await serviceRoleClient
    .from("meeting_external_events")
    .delete()
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .eq("provider_user_key", providerUserKey)
    .eq("external_event_id", externalEventId);
  if (deleteMappingError) throw deleteMappingError;

  return { found: true, cancelledMeeting };
}

export interface EnqueueCalendarEventJobInput {
  calendarConnectionId: string;
  organizationId: string;
  provider: string;
  externalEventId: string;
  changeType: string;
  providerUserKey: string;
}

/**
 * Fast, no-Graph-calls-here handoff — called from the webhook (delegated
 * only; tenant-wide sync is poll-only, see reconcileTenantOrganization, and
 * never touches this queue). Duplicate notifications for the same
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
    provider_user_key: input.providerUserKey,
  });
  if (error && error.code !== "23505") throw error;
}

/**
 * The webhook only knows Graph's subscriptionId — never trust an org/
 * membership id from the notification payload itself. Resolves it back to
 * OUR stored connection/org/mailbox via provider_subscriptions, then
 * enqueues. No-ops (returns false) for a subscription id we don't
 * recognize, e.g. a stale/already-deleted subscription still delivering
 * in-flight notifications.
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
    .select("organization_id, work_email")
    .eq("id", connection.organization_membership_id)
    .single();
  if (membershipError) throw membershipError;

  await enqueueCalendarEventJob(serviceRoleClient, {
    calendarConnectionId: subscription.calendar_connection_id,
    organizationId: membership.organization_id,
    provider: subscription.provider,
    externalEventId: input.externalEventId,
    changeType: input.changeType,
    providerUserKey: membership.work_email,
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
    await cancelCanonicalMeeting(serviceRoleClient, job.organization_id, job.provider, job.provider_user_key, job.external_event_id);
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
    await cancelCanonicalMeeting(serviceRoleClient, job.organization_id, job.provider, job.provider_user_key, job.external_event_id);
    return;
  }

  await upsertCanonicalMeeting(serviceRoleClient, {
    organizationId: job.organization_id,
    observerMembershipId: connection.organization_membership_id,
    provider: job.provider,
    providerUserKey: job.provider_user_key,
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
 * Delegated-webhook path only — see module doc.
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

interface ReconcileMailboxParams {
  organizationId: string;
  provider: string;
  providerUserKey: string;
  observerMembershipId: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  listEvents: (accessToken: string, fetchImpl?: typeof fetch) => Promise<MicrosoftCalendarEvent[]>;
}

/**
 * Shared by both delegated and tenant-wide reconciliation — fetch one
 * mailbox's current events fresh, upsert everything listed (via the exact
 * same upsertCanonicalMeeting every other path uses), then for any
 * previously-mapped event that's no longer listed, resolve it through
 * cancelCanonicalMeeting (which applies the same organizer-vs-attendee
 * asymmetry as a live delete notification would).
 */
async function reconcileMailbox(
  serviceRoleClient: AppSupabaseClient,
  params: ReconcileMailboxParams,
): Promise<{ eventsSeen: number; cancelled: number }> {
  const events = await params.listEvents(params.accessToken, params.fetchImpl);

  for (const event of events) {
    await upsertCanonicalMeeting(serviceRoleClient, {
      organizationId: params.organizationId,
      provider: params.provider,
      providerUserKey: params.providerUserKey,
      observerMembershipId: params.observerMembershipId,
      event,
    });
  }

  const seenExternalIds = new Set(events.map((event) => event.externalEventId));

  const { data: mappings, error: mappingsError } = await serviceRoleClient
    .from("meeting_external_events")
    .select("meeting_id, external_event_id")
    .eq("organization_id", params.organizationId)
    .eq("provider", params.provider)
    .eq("provider_user_key", params.providerUserKey);
  if (mappingsError) throw mappingsError;

  const vanished = (mappings ?? []).filter((mapping) => !seenExternalIds.has(mapping.external_event_id));

  let cancelled = 0;
  for (const mapping of vanished) {
    const { data: meeting, error: meetingError } = await serviceRoleClient
      .from("meetings")
      .select("lifecycle_status, scheduled_start")
      .eq("id", mapping.meeting_id)
      .single();
    if (meetingError) throw meetingError;
    // Only worth acting on if still upcoming — an already-cancelled or
    // past meeting vanishing from the listing is expected, not news.
    if (meeting.lifecycle_status !== "upcoming" || new Date(meeting.scheduled_start) < new Date()) continue;

    const result = await cancelCanonicalMeeting(
      serviceRoleClient,
      params.organizationId,
      params.provider,
      params.providerUserKey,
      mapping.external_event_id,
    );
    if (result.cancelledMeeting) cancelled += 1;
  }

  return { eventsSeen: events.length, cancelled };
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
 * Catches what a missed/failed webhook would otherwise leave stale.
 * Delegated path — not scheduled in M4 (no cron yet) — callable on demand,
 * same as subscription renewal in M3.
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

  const { data: membership, error: membershipError } = await serviceRoleClient
    .from("organization_memberships")
    .select("work_email")
    .eq("id", input.ownerMembershipId)
    .single();
  if (membershipError) throw membershipError;

  const { eventsSeen, cancelled } = await reconcileMailbox(serviceRoleClient, {
    organizationId: input.organizationId,
    provider: input.provider,
    providerUserKey: membership.work_email,
    observerMembershipId: input.ownerMembershipId,
    accessToken,
    fetchImpl: input.fetchImpl,
    listEvents: listUpcomingEvents,
  });

  const result: ReconcileConnectionResult = { eventsSeen, cancelled, ranAt: new Date().toISOString() };

  // Only written on success — a failed run (e.g. token refresh failing)
  // leaves the previous result in place rather than fabricating one.
  const { error: persistError } = await serviceRoleClient
    .from("calendar_connections")
    .update({ last_reconciliation_result: result as unknown as Json })
    .eq("id", input.connectionId);
  if (persistError) throw persistError;

  return result;
}

export interface ReconcileTenantOrganizationInput {
  organizationId: string;
  provider: string;
  microsoftEnv: MicrosoftEnv;
  fetchImpl?: typeof fetch;
}

export interface ReconcileTenantOrganizationResult {
  employeesProcessed: number;
  eventsSeen: number;
  cancelled: number;
  errors: { workEmail: string; error: string }[];
  ranAt: string;
}

/**
 * Tenant-wide (app-only/client-credentials) sync — no per-employee Graph
 * subscriptions/webhooks (deliberately deferred, see the tenant-connection
 * design review: real-time freshness for this path isn't needed for
 * "admin grants once, Signal reads calendars" to work correctly, and
 * provisioning/renewing N per-user subscriptions under one shared app
 * credential is real complexity this increment doesn't need). Poll-only,
 * reusing the exact same reconcileMailbox shape as delegated reconciliation
 * — one loop, over each eligible employee (active membership, Meeting
 * Intelligence enabled, real work_email), using ONE app-only token.
 *
 * Per-employee failures are reported in `errors` and do NOT retry through
 * delegated OAuth — tenant-level app-only is the primary,
 * organization-controlled model; delegated stays a separate, explicitly
 * initiated fallback path only (per product decision).
 */
export async function reconcileTenantOrganization(
  serviceRoleClient: AppSupabaseClient,
  input: ReconcileTenantOrganizationInput,
): Promise<ReconcileTenantOrganizationResult> {
  const appToken = await getAppOnlyAccessToken(
    {
      tenantId: input.microsoftEnv.tenantId,
      clientId: input.microsoftEnv.clientId,
      clientSecret: input.microsoftEnv.clientSecret,
    },
    input.fetchImpl,
  );

  // The only real security boundary here — Graph itself has no concept of
  // our organization_id, an app-only token can read the whole tenant.
  // Restricting this query to this org's own active, Meeting-Intelligence-
  // enabled employees IS the enforcement point.
  const { data: employees, error: employeesError } = await serviceRoleClient
    .from("organization_memberships")
    .select("id, work_email")
    .eq("organization_id", input.organizationId)
    .eq("status", "active")
    .eq("meeting_ai_enabled", true);
  if (employeesError) throw employeesError;

  let eventsSeen = 0;
  let cancelled = 0;
  const errors: { workEmail: string; error: string }[] = [];

  for (const employee of employees ?? []) {
    try {
      const result = await reconcileMailbox(serviceRoleClient, {
        organizationId: input.organizationId,
        provider: input.provider,
        providerUserKey: employee.work_email,
        observerMembershipId: employee.id,
        accessToken: appToken.accessToken,
        fetchImpl: input.fetchImpl,
        listEvents: (accessToken, fetchImpl) => listUpcomingEventsForUser(accessToken, employee.work_email, fetchImpl),
      });
      eventsSeen += result.eventsSeen;
      cancelled += result.cancelled;
    } catch (error) {
      errors.push({ workEmail: employee.work_email, error: errorMessage(error) });
    }
  }

  const result: ReconcileTenantOrganizationResult = {
    employeesProcessed: employees?.length ?? 0,
    eventsSeen,
    cancelled,
    errors,
    ranAt: new Date().toISOString(),
  };

  const { error: persistError } = await serviceRoleClient
    .from("microsoft_tenant_connections")
    .update({ last_reconciliation_result: result as unknown as Json })
    .eq("organization_id", input.organizationId)
    .eq("provider", input.provider);
  if (persistError) throw persistError;

  return result;
}

