import { describe, expect, it, vi } from "vitest";
import { encryptToken, type MicrosoftCalendarEvent } from "@applywizz/microsoft";
import {
  cancelCanonicalMeeting,
  enqueueCalendarEventJob,
  enqueueCalendarEventJobForSubscription,
  processCalendarEventQueue,
  reconcileCalendarConnection,
  upsertCanonicalMeeting,
  type AppSupabaseClient,
} from "./meetings";

type Handlers = Record<
  string,
  {
    select?: (filters: Record<string, unknown>) => { data: unknown; error: unknown };
    insert?: (payload: unknown) => { data: unknown; error: unknown };
    upsert?: (payload: unknown) => { data: unknown; error: unknown };
    update?: (payload: unknown, filters: Record<string, unknown>) => { data: unknown; error: unknown };
    delete?: (filters: Record<string, unknown>) => { data: unknown; error: unknown };
  }
>;

/** Same fake shape as microsoft-connection.test.ts, extended with delete()/rpc() for meetings.ts's chains. */
function createFakeSupabase(handlers: Handlers, rpc?: (name: string) => { data: unknown; error: unknown }): AppSupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let op: { type: "select" | "insert" | "upsert" | "update" | "delete"; payload?: unknown } = { type: "select" };

    function resolve() {
      const h = handlers[table] ?? {};
      if (op.type === "insert" && h.insert) return h.insert(op.payload);
      if (op.type === "upsert" && h.upsert) return h.upsert(op.payload);
      if (op.type === "update" && h.update) return h.update(op.payload, filters);
      if (op.type === "delete" && h.delete) return h.delete(filters);
      if (h.select) return h.select(filters);
      return { data: null, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(payload: unknown) {
        op = { type: "insert", payload };
        return builder;
      },
      upsert(payload: unknown) {
        op = { type: "upsert", payload };
        return builder;
      },
      update(payload: unknown) {
        op = { type: "update", payload };
        return builder;
      },
      delete() {
        op = { type: "delete" };
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
};

const microsoftEnv = { tenantId: "t", clientId: "c", clientSecret: "s", webhookClientState: "cs" };

describe("upsertCanonicalMeeting", () => {
  it("upserts the meeting then replaces attendees wholesale", async () => {
    const deleteSpy = vi.fn(() => ({ data: null, error: null }));
    const insertSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      meetings: { upsert: () => ({ data: { id: "meeting-1" }, error: null }) },
      meeting_attendees: { delete: deleteSpy, insert: insertSpy },
    });

    const result = await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      ownerMembershipId: "m1",
      provider: "microsoft",
      event: baseEvent,
    });

    expect(result).toEqual({ meetingId: "meeting-1" });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).toHaveBeenCalledTimes(1);
  });

  it("skips the attendee insert when the event has none", async () => {
    const insertSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      meetings: { upsert: () => ({ data: { id: "meeting-1" }, error: null }) },
      meeting_attendees: { delete: () => ({ data: null, error: null }), insert: insertSpy },
    });

    await upsertCanonicalMeeting(supabase, {
      organizationId: "org-1",
      ownerMembershipId: "m1",
      provider: "microsoft",
      event: { ...baseEvent, attendees: [] },
    });

    expect(insertSpy).not.toHaveBeenCalled();
  });
});

describe("cancelCanonicalMeeting", () => {
  it("reports found:true when a matching meeting exists", async () => {
    const supabase = createFakeSupabase({
      meetings: { update: () => ({ data: { id: "meeting-1" }, error: null }) },
    });
    await expect(cancelCanonicalMeeting(supabase, "org-1", "microsoft", "evt-1")).resolves.toEqual({ found: true });
  });

  it("no-ops (found:false) when nothing matches — out-of-order deletes are normal", async () => {
    const supabase = createFakeSupabase({
      meetings: { update: () => ({ data: null, error: null }) },
    });
    await expect(cancelCanonicalMeeting(supabase, "org-1", "microsoft", "evt-missing")).resolves.toEqual({ found: false });
  });
});

describe("enqueueCalendarEventJob", () => {
  it("swallows a unique-violation (already-pending duplicate) instead of throwing", async () => {
    const supabase = createFakeSupabase({
      calendar_event_jobs: { insert: () => ({ data: null, error: { code: "23505", message: "duplicate" } }) },
    });
    await expect(
      enqueueCalendarEventJob(supabase, {
        calendarConnectionId: "conn-1",
        organizationId: "org-1",
        provider: "microsoft",
        externalEventId: "evt-1",
        changeType: "updated",
      }),
    ).resolves.toBeUndefined();
  });

  it("rethrows any other error", async () => {
    const supabase = createFakeSupabase({
      calendar_event_jobs: { insert: () => ({ data: null, error: { code: "23503", message: "fk violation" } }) },
    });
    await expect(
      enqueueCalendarEventJob(supabase, {
        calendarConnectionId: "conn-1",
        organizationId: "org-1",
        provider: "microsoft",
        externalEventId: "evt-1",
        changeType: "updated",
      }),
    ).rejects.toBeTruthy();
  });
});

describe("enqueueCalendarEventJobForSubscription", () => {
  it("resolves connection/org from the subscription id, never trusting the payload, then enqueues", async () => {
    const insertSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      provider_subscriptions: {
        select: () => ({ data: { calendar_connection_id: "conn-1", provider: "microsoft" }, error: null }),
      },
      calendar_connections: { select: () => ({ data: { organization_membership_id: "m1" }, error: null }) },
      organization_memberships: { select: () => ({ data: { organization_id: "org-1" }, error: null }) },
      calendar_event_jobs: { insert: insertSpy },
    });

    const found = await enqueueCalendarEventJobForSubscription(supabase, {
      externalSubscriptionId: "sub-1",
      externalEventId: "evt-1",
      changeType: "updated",
    });

    expect(found).toBe(true);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ calendar_connection_id: "conn-1", organization_id: "org-1" }),
    );
  });

  it("returns false for an unrecognized subscription id without enqueuing anything", async () => {
    const insertSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      provider_subscriptions: { select: () => ({ data: null, error: null }) },
      calendar_event_jobs: { insert: insertSpy },
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

describe("processCalendarEventQueue", () => {
  function accessTokenSupabaseHandlers() {
    return {
      calendar_connections: { select: () => ({ data: { organization_membership_id: "m1" }, error: null }) },
      calendar_connection_secrets: {
        select: () => ({
          data: {
            encrypted_access_token: JSON.stringify({ noop: true }),
            encrypted_refresh_token: null,
            access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          error: null,
        }),
      },
    };
  }

  it("cancels the meeting directly for a deleted job, without calling Graph", async () => {
    const job = {
      id: "job-1",
      calendar_connection_id: "conn-1",
      organization_id: "org-1",
      provider: "microsoft",
      external_event_id: "evt-1",
      change_type: "deleted",
      status: "processing",
      attempts: 0,
      last_error: null,
      run_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let claimed = false;
    const updateSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase(
      {
        ...accessTokenSupabaseHandlers(),
        meetings: { update: () => ({ data: { id: "meeting-1" }, error: null }) },
        calendar_event_jobs: { update: updateSpy },
      },
      () => {
        if (claimed) return { data: null, error: null };
        claimed = true;
        return { data: job, error: null };
      },
    );

    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });

    expect(result).toEqual({ processed: 1, succeeded: 1, retried: 0, deadLettered: 0 });
    expect(updateSpy).toHaveBeenCalledWith({ status: "completed" }, expect.anything());
  });

  it("retries with incremented attempts on failure, then dead-letters once maxAttempts is reached", async () => {
    const job = {
      id: "job-1",
      calendar_connection_id: "conn-1",
      organization_id: "org-1",
      provider: "microsoft",
      external_event_id: "evt-1",
      change_type: "updated",
      status: "processing",
      attempts: 1,
      last_error: null,
      run_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    let claimed = false;
    const updateSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase(
      {
        calendar_connections: { select: () => ({ data: null, error: { message: "not found" } }) },
        calendar_event_jobs: { update: updateSpy },
      },
      () => {
        if (claimed) return { data: null, error: null };
        claimed = true;
        return { data: job, error: null };
      },
    );

    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key", maxAttempts: 2 });

    expect(result).toEqual({ processed: 1, succeeded: 0, retried: 0, deadLettered: 1 });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "dead_letter", attempts: 2 }),
      expect.anything(),
    );
  });

  it("stops as soon as the claim function returns no job", async () => {
    const supabase = createFakeSupabase({}, () => ({ data: null, error: null }));
    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });
    expect(result).toEqual({ processed: 0, succeeded: 0, retried: 0, deadLettered: 0 });
  });

  it("also stops on PostgREST's real 'no job' shape — an all-null object, not JSON null", async () => {
    // Confirmed against the real local Postgres/PostgREST stack: a
    // composite-NULL return from claim_next_calendar_event_job() comes
    // back as { id: null, ... } rather than a bare null.
    const supabase = createFakeSupabase(
      {},
      () => ({
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
          created_at: null,
          updated_at: null,
        },
        error: null,
      }),
    );
    const result = await processCalendarEventQueue(supabase, { microsoftEnv, encryptionKey: "key" });
    expect(result).toEqual({ processed: 0, succeeded: 0, retried: 0, deadLettered: 0 });
  });
});

describe("reconcileCalendarConnection", () => {
  it("upserts every listed event and cancels an upcoming meeting no longer present", async () => {
    const cancelSpy = vi.fn(() => ({ data: { id: "meeting-stale" }, error: null }));
    const upsertSpy = vi.fn(() => ({ data: { id: "meeting-1" }, error: null }));
    const supabase = createFakeSupabase({
      calendar_connection_secrets: {
        select: () => ({
          data: {
            encrypted_access_token: encryptToken("access-token", "key"),
            encrypted_refresh_token: null,
            access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
          error: null,
        }),
      },
      meetings: {
        upsert: upsertSpy,
        select: () => ({
          data: [
            { id: "meeting-1", external_event_id: "evt-1" },
            { id: "meeting-stale", external_event_id: "evt-gone" },
          ],
          error: null,
        }),
        update: cancelSpy,
      },
      meeting_attendees: {
        delete: () => ({ data: null, error: null }),
        insert: () => ({ data: null, error: null }),
      },
    });

    const fetchImpl = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/me/calendarView")) {
        return new Response(JSON.stringify({ value: [{ id: "evt-1", isOnlineMeeting: false }] }), {
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

    expect(result).toEqual({ eventsSeen: 1, cancelled: 1 });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledWith({ lifecycle_status: "cancelled" }, expect.anything());
  });
});
