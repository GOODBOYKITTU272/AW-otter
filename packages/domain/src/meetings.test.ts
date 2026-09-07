import { describe, expect, it, vi } from "vitest";
import { encryptToken, type MicrosoftCalendarEvent } from "@applywizz/microsoft";
import {
  cancelCanonicalMeeting,
  enqueueCalendarEventJob,
  enqueueCalendarEventJobForSubscription,
  processCalendarEventQueue,
  reconcileCalendarConnection,
  reconcileTenantOrganization,
  upsertCanonicalMeeting,
  type AppSupabaseClient,
} from "./meetings";

interface Call {
  op: "select" | "insert" | "upsert" | "update" | "delete";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type TableHandler = (call: Call) => { data: unknown; error: unknown };

/**
 * A more flexible fake than earlier rounds needed: each table's handler
 * sees the full call (op + payload + filters), so one test can distinguish
 * between the several different calls the new resolve-or-create logic
 * makes against the SAME table (e.g. meetings gets both a select-by-
 * ical_uid and a later update in one upsertCanonicalMeeting call).
 */
function createFakeSupabase(
  handlers: Record<string, TableHandler>,
  rpc?: (name: string) => { data: unknown; error: unknown },
): AppSupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let op: Call["op"] = "select";
    let payload: unknown;

    function resolve() {
      const handler = handlers[table];
      if (!handler) return { data: null, error: null };
      return handler({ op, payload, filters });
    }

    const builder = {
      select() {
        return builder;
      },
      insert(p: unknown) {
        op = "insert";
        payload = p;
        return builder;
      },
      upsert(p: unknown) {
        op = "upsert";
        payload = p;
        return builder;
      },
      update(p: unknown) {
        op = "update";
        payload = p;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      gte(column: string, value: unknown) {
        filters[column] = { gte: value };
        return builder;
      },
      order() {
        return builder;
      },
      async maybeSingle() {
        return resolve();
      },
      async single() {
        return resolve();
      },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from, rpc: (name: string) => Promise.resolve(rpc?.(name) ?? { data: null, error: null }) } as unknown as AppSupabaseClient;
}

const baseEvent: MicrosoftCalendarEvent = {
  externalEventId: "evt-1",
  subject: "Sync",
  start: "2026-09-10T00:00:00Z",
  end: "2026-09-10T01:00:00Z",
  organizer: { name: "Ada", email: "ada@applywizz.test" },
  attendees: [{ name: "Bo", email: "bo@applywizz.test" }],
  isOnlineMeeting: true,
  onlineMeetingProvider: "teamsForBusiness",
  joinUrl: "https://teams.example/evt-1",
  lastModified: "2026-09-01T00:00:00Z",
  icalUId: "ical-uid-1",
  graphEventType: "singleInstance",
  seriesMasterId: null,
  originalStart: null,
  isOrganizer: true,
};

const microsoftEnv = { tenantId: "t", clientId: "c", clientSecret: "s", webhookClientState: "cs" };

function ok(data: unknown = null) {
  return { data, error: null };
}

describe("upsertCanonicalMeeting", () => {
  it("creates a new canonical meeting when neither the mapping nor icalUId match", async () => {
    const meetingsInsertSpy = vi.fn(() => ok({ id: "meeting-1" }));
    const mappingUpsertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok(null) : mappingUpsertSpy()),
      meetings: (call) => (call.op === "select" ? ok(null) : meetingsInsertSpy()),
      meeting_attendees: () => ok(null),
    });

    const result = await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "am1@applywizz.test",
      observerMembershipId: "m1",
      event: baseEvent,
    });

    expect(result).toEqual({ meetingId: "meeting-1" });
    expect(meetingsInsertSpy).toHaveBeenCalledTimes(1);
    expect(mappingUpsertSpy).toHaveBeenCalledTimes(1);
  });

  it("sets owner_membership_id on insert to the observer", async () => {
    let insertPayload: unknown;
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok(null) : ok(null)),
      meetings: (call) => {
        if (call.op === "select") return ok(null);
        insertPayload = call.payload;
        return ok({ id: "meeting-1" });
      },
      meeting_attendees: () => ok(null),
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "am1@applywizz.test",
      observerMembershipId: "m1",
      event: baseEvent,
    });

    expect(insertPayload).toMatchObject({ owner_membership_id: "m1", ical_uid: "ical-uid-1" });
  });

  it("regression (Codex final review, Finding #1): a non-organizer's first-sighting insert never includes owner_membership_id in its payload", async () => {
    // This is the exact mechanism the race depends on: supabase-js's
    // upsert() sets every column PRESENT in the payload on both the fresh
    // insert AND the ON CONFLICT DO UPDATE path. Before the fix,
    // owner_membership_id was unconditionally included here, so if this
    // non-organizer's upsert lost a race against a concurrent organizer
    // insert, its conflict-update would have overwritten the organizer's
    // already-correct ownership. Asserting the KEY IS ABSENT (not merely
    // null) is what proves the DO UPDATE SET clause can never touch the
    // column at all — this test fails against the pre-fix code (which
    // always included the key) and passes only with the conditional spread.
    let insertPayload: Record<string, unknown> | undefined;
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok(null) : ok(null)),
      meetings: (call) => {
        if (call.op === "select") return ok(null);
        insertPayload = call.payload as Record<string, unknown>;
        return ok({ id: "meeting-1" });
      },
      meeting_attendees: () => ok(null),
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "attendee@applywizz.test",
      observerMembershipId: "attendee-membership",
      event: { ...baseEvent, isOrganizer: false },
    });

    expect(insertPayload).toBeDefined();
    expect(Object.hasOwn(insertPayload!, "owner_membership_id")).toBe(false);
  });

  it("uses the mapping fast path when this exact mailbox+event pair is already known", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok({ meeting_id: "meeting-1" }) : ok(null)),
      meetings: (call) => {
        if (call.op === "select") return ok({ scheduled_start: baseEvent.start, scheduled_end: baseEvent.end });
        return meetingsUpdateSpy(call.payload);
      },
      meeting_attendees: () => ok(null),
    });

    const result = await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "am1@applywizz.test",
      observerMembershipId: "m1",
      event: baseEvent,
    });

    expect(result).toEqual({ meetingId: "meeting-1" });
    expect(meetingsUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ reason_code: null }));
  });

  it("a new mailbox observing an existing meeting (found via icalUId) creates only a mapping row, not a new meeting", async () => {
    const meetingsInsertSpy = vi.fn();
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok(null) : ok(null)),
      meetings: (call) => {
        if (call.op === "select" && call.filters.ical_uid) return ok({ id: "meeting-1" });
        if (call.op === "select") return ok({ scheduled_start: baseEvent.start, scheduled_end: baseEvent.end });
        if (call.op === "update") return meetingsUpdateSpy(call.payload);
        meetingsInsertSpy();
        return ok({ id: "should-not-happen" });
      },
      meeting_attendees: () => ok(null),
    });

    const result = await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "manager@applywizz.test",
      observerMembershipId: "m2",
      event: baseEvent,
    });

    expect(result).toEqual({ meetingId: "meeting-1" });
    expect(meetingsInsertSpy).not.toHaveBeenCalled();
    expect(meetingsUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("marks reason_code 'rescheduled' when the stored meeting's time differs", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok({ meeting_id: "meeting-1" }) : ok(null)),
      meetings: (call) => {
        if (call.op === "select") {
          return ok({ scheduled_start: "2026-09-01T00:00:00Z", scheduled_end: "2026-09-01T01:00:00Z" });
        }
        return meetingsUpdateSpy(call.payload);
      },
      meeting_attendees: () => ok(null),
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "am1@applywizz.test",
      observerMembershipId: "m1",
      event: baseEvent,
    });

    expect(meetingsUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ reason_code: "rescheduled" }));
  });

  it("only reassigns owner_membership_id when the observation is from the organizer", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok({ meeting_id: "meeting-1" }) : ok(null)),
      meetings: (call) => {
        if (call.op === "select") return ok({ scheduled_start: baseEvent.start, scheduled_end: baseEvent.end });
        return meetingsUpdateSpy(call.payload);
      },
      meeting_attendees: () => ok(null),
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "attendee@applywizz.test",
      observerMembershipId: "m2",
      event: { ...baseEvent, isOrganizer: false },
    });

    const payload = meetingsUpdateSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("owner_membership_id");
  });

  it("replaces attendees wholesale (delete then insert)", async () => {
    const deleteSpy = vi.fn((_payload?: unknown) => ok(null));
    const insertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) => (call.op === "select" ? ok(null) : ok(null)),
      meetings: (call) => (call.op === "select" ? ok(null) : ok({ id: "meeting-1" })),
      meeting_attendees: (call) => (call.op === "delete" ? deleteSpy() : insertSpy()),
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      providerUserKey: "am1@applywizz.test",
      observerMembershipId: "m1",
      event: baseEvent,
    });

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });
});

describe("cancelCanonicalMeeting", () => {
  it("no-ops when the mailbox+event pair was never mapped — out-of-order deletes are normal", async () => {
    const supabase = createFakeSupabase({
      meeting_external_events: () => ok(null),
    });
    await expect(cancelCanonicalMeeting(supabase, "org-1", "microsoft", "am1@applywizz.test", "evt-1")).resolves.toEqual({
      found: false,
      cancelledMeeting: false,
    });
  });

  it("cancels the canonical meeting when the organizer's own mailbox loses the event", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const mappingDeleteSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) =>
        call.op === "select" ? ok({ meeting_id: "meeting-1", is_organizer: true }) : mappingDeleteSpy(),
      meetings: (call) => meetingsUpdateSpy(call.payload),
    });

    const result = await cancelCanonicalMeeting(supabase, "org-1", "microsoft", "organizer@applywizz.test", "evt-1");

    expect(result).toEqual({ found: true, cancelledMeeting: true });
    expect(meetingsUpdateSpy).toHaveBeenCalledWith({ lifecycle_status: "cancelled" });
    expect(mappingDeleteSpy).toHaveBeenCalledTimes(1);
  });

  it("only removes the observer's mapping when a non-organizer's copy disappears — the meeting is untouched", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const mappingDeleteSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_external_events: (call) =>
        call.op === "select" ? ok({ meeting_id: "meeting-1", is_organizer: false }) : mappingDeleteSpy(),
      meetings: (call) => meetingsUpdateSpy(call.payload),
    });

    const result = await cancelCanonicalMeeting(supabase, "org-1", "microsoft", "attendee@applywizz.test", "evt-1");

    expect(result).toEqual({ found: true, cancelledMeeting: false });
    expect(meetingsUpdateSpy).not.toHaveBeenCalled();
    expect(mappingDeleteSpy).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueCalendarEventJob", () => {
  it("swallows a unique-violation (already-pending duplicate) instead of throwing", async () => {
    const supabase = createFakeSupabase({
      calendar_event_jobs: () => ({ data: null, error: { code: "23505", message: "duplicate" } }),
    });
    await expect(
      enqueueCalendarEventJob(supabase, {
        calendarConnectionId: "conn-1",
        organizationId: "org-1",
        provider: "microsoft",
        externalEventId: "evt-1",
        changeType: "updated",
        providerUserKey: "am1@applywizz.test",
      }),
    ).resolves.toBeUndefined();
  });

  it("rethrows any other error", async () => {
    const supabase = createFakeSupabase({
      calendar_event_jobs: () => ({ data: null, error: { code: "23503", message: "fk violation" } }),
    });
    await expect(
      enqueueCalendarEventJob(supabase, {
        calendarConnectionId: "conn-1",
        organizationId: "org-1",
        provider: "microsoft",
        externalEventId: "evt-1",
        changeType: "updated",
        providerUserKey: "am1@applywizz.test",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("enqueueCalendarEventJobForSubscription", () => {
  it("resolves connection/org/providerUserKey from the subscription id, never trusting the payload, then enqueues", async () => {
    const insertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      provider_subscriptions: () => ok({ calendar_connection_id: "conn-1", provider: "microsoft" }),
      calendar_connections: () => ok({ organization_membership_id: "m1" }),
      organization_memberships: () => ok({ organization_id: "org-1", work_email: "am1@applywizz.test" }),
      calendar_event_jobs: (call) => insertSpy(call.payload),
    });

    const found = await enqueueCalendarEventJobForSubscription(supabase, {
      externalSubscriptionId: "sub-1",
      externalEventId: "evt-1",
      changeType: "updated",
    });

    expect(found).toBe(true);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ calendar_connection_id: "conn-1", organization_id: "org-1", provider_user_key: "am1@applywizz.test" }),
    );
  });

  it("returns false for an unrecognized subscription id without enqueuing anything", async () => {
    const insertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      provider_subscriptions: () => ok(null),
      calendar_event_jobs: (call) => insertSpy(call.payload),
    });

    await expect(
      enqueueCalendarEventJobForSubscription(supabase, {
        externalSubscriptionId: "sub-unknown",
        externalEventId: "evt-1",
        changeType: "updated",
      }),
    ).resolves.toBe(false);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});

function fakeJob(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    calendar_connection_id: "conn-1",
    organization_id: "org-1",
    provider: "microsoft",
    external_event_id: "evt-1",
    change_type: "updated",
    status: "processing",
    attempts: 0,
    last_error: null,
    run_at: new Date().toISOString(),
    provider_user_key: "am1@applywizz.test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("processCalendarEventQueue", () => {
  it("cancels the meeting directly for a deleted job, without calling Graph", async () => {
    const job = fakeJob({ change_type: "deleted" });
    let claimed = false;
    const jobUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase(
      {
        calendar_connections: () => ok({ organization_membership_id: "m1" }),
        meeting_external_events: (call) =>
          call.op === "select" ? ok({ meeting_id: "meeting-1", is_organizer: true }) : ok(null),
        meetings: (call) => meetingsUpdateSpy(call.payload),
        calendar_event_jobs: (call) => jobUpdateSpy(call.payload),
      },
      () => {
        if (claimed) return { data: null, error: null };
        claimed = true;
        return { data: job, error: null };
      },
    );

    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });

    expect(result).toEqual({ processed: 1, succeeded: 1, retried: 0, deadLettered: 0 });
    expect(meetingsUpdateSpy).toHaveBeenCalledWith({ lifecycle_status: "cancelled" });
    expect(jobUpdateSpy).toHaveBeenCalledWith({ status: "completed" });
  });

  it("retries with incremented attempts on failure, then dead-letters once maxAttempts is reached", async () => {
    const job = fakeJob({ attempts: 1 });
    let claimed = false;
    const jobUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase(
      {
        calendar_connections: () => ({ data: null, error: { message: "not found" } }),
        calendar_event_jobs: (call) => jobUpdateSpy(call.payload),
      },
      () => {
        if (claimed) return { data: null, error: null };
        claimed = true;
        return { data: job, error: null };
      },
    );

    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key", maxAttempts: 2 });

    expect(result).toEqual({ processed: 1, succeeded: 0, retried: 0, deadLettered: 1 });
    expect(jobUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", attempts: 2 }));
  });

  it("stops as soon as the claim function returns no job", async () => {
    const supabase = createFakeSupabase({}, () => ({ data: null, error: null }));
    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });
    expect(result).toEqual({ processed: 0, succeeded: 0, retried: 0, deadLettered: 0 });
  });

  it("also stops on PostgREST's real 'no job' shape — an all-null object, not JSON null", async () => {
    const supabase = createFakeSupabase({}, () => ({
      data: {
        id: null,
        calendar_connection_id: null,
        organization_id: null,
        provider: null,
        external_event_id: null,
        change_type: null,
        status: null,
        attempts: null,
        last_error: null,
        run_at: null,
        provider_user_key: null,
        created_at: null,
        updated_at: null,
      },
      error: null,
    }));
    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });
    expect(result).toEqual({ processed: 0, succeeded: 0, retried: 0, deadLettered: 0 });
  });
});

describe("reconcileCalendarConnection", () => {
  it("upserts every listed event and cancels an upcoming meeting no longer present", async () => {
    const cancelSpy = vi.fn((_payload?: unknown) => ok(null));
    const persistSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      calendar_connection_secrets: () =>
        ok({
          encrypted_access_token: encryptToken("access-token", "key"),
          encrypted_refresh_token: null,
          access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      organization_memberships: () => ok({ work_email: "am1@applywizz.test" }),
      meeting_external_events: (call) => {
        if (call.op === "delete") return ok(null);
        if (call.op === "upsert") return ok(null);
        if (call.op === "select" && !call.filters.external_event_id) {
          // The vanished-mapping listing (provider + provider_user_key only, no specific event id).
          return ok([
            { meeting_id: "meeting-1", external_event_id: "evt-1" },
            { meeting_id: "meeting-stale", external_event_id: "evt-gone" },
          ]);
        }
        if (call.op === "select" && call.filters.external_event_id === "evt-gone") {
          // cancelCanonicalMeeting's resolve step for the vanished mapping.
          return ok({ meeting_id: "meeting-stale", is_organizer: true });
        }
        // upsertCanonicalMeeting's fast-path lookup for evt-1 — not yet known.
        return ok(null);
      },
      meetings: (call) => {
        if (call.op === "select" && call.filters.id === "meeting-stale") {
          return ok({ lifecycle_status: "upcoming", scheduled_start: new Date(Date.now() + 3600_000).toISOString() });
        }
        if (call.op === "select" && call.filters.ical_uid) {
          // No existing canonical meeting yet for evt-1's icalUId — proceeds to insert.
          return ok(null);
        }
        if (call.op === "update") return cancelSpy(call.payload);
        return ok({ id: "meeting-1" });
      },
      meeting_attendees: () => ok(null),
      calendar_connections: (call) => persistSpy(call.payload),
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/me/calendarView")) {
        return new Response(JSON.stringify({ value: [{ id: "evt-1", isOnlineMeeting: false, iCalUId: "ical-1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const result = await reconcileCalendarConnection(supabase, {
      connectionId: "conn-1",
      organizationId: "org-1",
      ownerMembershipId: "m1",
      provider: "microsoft",
      microsoftEnv,
      encryptionKey: "key",
      fetchImpl,
    });

    expect(result).toEqual({ eventsSeen: 1, cancelled: 1, ranAt: expect.any(String) });
    expect(cancelSpy).toHaveBeenCalledWith({ lifecycle_status: "cancelled" });
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ last_reconciliation_result: expect.objectContaining({ eventsSeen: 1, cancelled: 1 }) }),
    );
  });
});

describe("reconcileTenantOrganization", () => {
  it("loops every eligible employee with one app-only token and aggregates results", async () => {
    const persistSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      organization_memberships: (call) => {
        if (call.op === "select" && call.filters.organization_id) {
          return ok([
            { id: "m1", work_email: "am1@applywizz.test" },
            { id: "m2", work_email: "am2@applywizz.test" },
          ]);
        }
        return ok(null);
      },
      meeting_external_events: (call) => (call.op === "select" ? ok([]) : ok(null)),
      meetings: (call) => (call.op === "select" ? ok(null) : ok({ id: "meeting-1" })),
      meeting_attendees: () => ok(null),
      microsoft_tenant_connections: (call) => persistSpy(call.payload),
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "app-only-at", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/users/am1%40applywizz.test/calendarView")) {
        return new Response(JSON.stringify({ value: [{ id: "e1", iCalUId: "ical-1", isOnlineMeeting: false }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/users/am2%40applywizz.test/calendarView")) {
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const result = await reconcileTenantOrganization(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      microsoftEnv,
      fetchImpl,
    });

    expect(result.employeesProcessed).toBe(2);
    expect(result.eventsSeen).toBe(1);
    expect(result.errors).toEqual([]);
    expect(persistSpy).toHaveBeenCalledWith(
      expect.objectContaining({ last_reconciliation_result: expect.objectContaining({ employeesProcessed: 2, eventsSeen: 1 }) }),
    );
  });

  it("captures a per-employee failure without throwing or stopping other employees", async () => {
    const supabase = createFakeSupabase({
      organization_memberships: (call) =>
        call.op === "select" && call.filters.organization_id
          ? ok([
              { id: "m1", work_email: "broken@applywizz.test" },
              { id: "m2", work_email: "am2@applywizz.test" },
            ])
          : ok(null),
      meeting_external_events: (call) => (call.op === "select" ? ok([]) : ok(null)),
      meetings: (call) => (call.op === "select" ? ok(null) : ok({ id: "meeting-1" })),
      meeting_attendees: () => ok(null),
      microsoft_tenant_connections: () => ok(null),
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth2/v2.0/token")) {
        return new Response(JSON.stringify({ access_token: "app-only-at", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/users/broken%40applywizz.test/calendarView")) {
        return new Response(JSON.stringify({ error: { code: "NotFound", message: "mailbox not found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/users/am2%40applywizz.test/calendarView")) {
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    };

    const result = await reconcileTenantOrganization(supabase, {
      organizationId: "org-1",
      provider: "microsoft",
      microsoftEnv,
      fetchImpl,
    });

    expect(result.employeesProcessed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.workEmail).toBe("broken@applywizz.test");
  });
});
