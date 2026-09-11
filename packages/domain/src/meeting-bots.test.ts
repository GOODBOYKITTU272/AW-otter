import { describe, expect, it, vi } from "vitest";
import { FakeMeetingBotProvider, type MeetingBotProvider } from "@applywizz/meeting-bots";
import {
  processPendingBotJobs,
  syncBotStatuses,
  syncMeetingBotIntent,
  type AppSupabaseClient,
} from "./meeting-bots";

interface Call {
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type TableHandler = (call: Call) => { data: unknown; error: unknown };

function createFakeSupabase(
  handlers: Record<string, TableHandler>,
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
      update(p: unknown) {
        op = "update";
        payload = p;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      not(column: string, _operator: string, value: unknown) {
        filters[`not_${column}`] = value;
        return builder;
      },
      in(column: string, values: unknown) {
        filters[`in_${column}`] = values;
        return builder;
      },
      or(_conditions: string) {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        return resolve();
      },
      async single() {
        return resolve();
      },
      then(
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from } as unknown as AppSupabaseClient;
}

function ok(data: unknown = null) {
  return { data, error: null };
}

// processPendingBotJobs now makes a bulk timing lookup against `meetings`
// (filtered with .in("id", ...)) BEFORE the per-job meeting_url fetch
// (filtered with .eq("id", ...)) — same table, distinguishable by which
// filter key the fake harness recorded. `dueTimingRow` describes a
// meeting that started "now" (always due under any positive lead time)
// and ends 30 minutes out (never trips the already-ended check) — the
// right default for every test that isn't specifically testing timing.
function dueTimingRow(meetingId = "m1") {
  return {
    id: meetingId,
    scheduled_start: new Date().toISOString(),
    scheduled_end: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
}

function meetingsHandler(meetingUrlRow: { meeting_url: string | null }) {
  return (call: Call) =>
    "in_id" in call.filters ? ok([dueTimingRow()]) : ok(meetingUrlRow);
}

const eligibleMeeting = {
  id: "m1",
  organization_id: "org-1",
  meeting_url: "https://teams.example/x",
  eligibility_status: "record",
  lifecycle_status: "upcoming",
};

describe("syncMeetingBotIntent", () => {
  it("creates a pending bot job when a meeting is record+upcoming and none exists", async () => {
    const insertSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const eventSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select" ? ok(eligibleMeeting) : ok(null),
      meeting_bot_jobs: (call) => {
        if (call.op === "select") return ok(null); // no live job, no prior generation
        if (call.op === "insert") return insertSpy(call.payload);
        return ok(null);
      },
      meeting_lifecycle_events: (call) => eventSpy(call.payload),
    });

    await syncMeetingBotIntent(supabase, new FakeMeetingBotProvider(), "m1");

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        meeting_id: "m1",
        organization_id: "org-1",
        status: "pending",
        generation: 1,
        idempotency_key: "m1:1",
      }),
    );
    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "bot_intent.created" }),
    );
  });

  it("is idempotent: no-ops when a live job already exists", async () => {
    const insertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select" ? ok(eligibleMeeting) : ok(null),
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok({
              id: "job-1",
              status: "scheduled",
              generation: 1,
              provider_bot_id: "bot-1",
            })
          : insertSpy(call.payload),
    });

    await syncMeetingBotIntent(supabase, new FakeMeetingBotProvider(), "m1");

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("does nothing when the meeting has no join URL yet", async () => {
    const insertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select"
          ? ok({ ...eligibleMeeting, meeting_url: null })
          : ok(null),
      meeting_bot_jobs: (call) =>
        call.op === "select" ? ok(null) : insertSpy(call.payload),
    });

    await syncMeetingBotIntent(supabase, new FakeMeetingBotProvider(), "m1");

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("treats a unique-violation on insert as the idempotency guarantee working, not an error", async () => {
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select" ? ok(eligibleMeeting) : ok(null),
      meeting_bot_jobs: (call) => {
        if (call.op === "select") return ok(null);
        if (call.op === "insert")
          return { data: null, error: { code: "23505", message: "duplicate" } };
        return ok(null);
      },
    });

    await expect(
      syncMeetingBotIntent(supabase, new FakeMeetingBotProvider(), "m1"),
    ).resolves.toBeUndefined();
  });

  it("cancels a pending/scheduled bot job when the meeting is no longer eligible", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok(null));
    const provider = new FakeMeetingBotProvider();
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select"
          ? ok({ ...eligibleMeeting, eligibility_status: "exclude" })
          : ok(null),
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok({
              id: "job-1",
              status: "scheduled",
              generation: 1,
              provider_bot_id: "fake-bot-1",
            })
          : updateSpy(call.payload),
    });

    await syncMeetingBotIntent(supabase, provider, "m1");

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("leaves an already-joined bot alone — never cancels it", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select"
          ? ok({ ...eligibleMeeting, eligibility_status: "exclude" })
          : ok(null),
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok({
              id: "job-1",
              status: "joined",
              generation: 1,
              provider_bot_id: "fake-bot-1",
            })
          : updateSpy(call.payload),
    });

    await syncMeetingBotIntent(supabase, new FakeMeetingBotProvider(), "m1");

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("cancels via the provider when the job already has a provider_bot_id", async () => {
    const provider = new FakeMeetingBotProvider();
    const created = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "m1:1",
      botName: "AW Echo · John",
    });
    const cancelSpy = vi.spyOn(provider, "cancelBot");
    const supabase = createFakeSupabase({
      meetings: (call) =>
        call.op === "select"
          ? ok({ ...eligibleMeeting, eligibility_status: "exclude" })
          : ok(null),
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok({
              id: "job-1",
              status: "scheduled",
              generation: 1,
              provider_bot_id: created.providerBotId,
            })
          : ok({ id: "job-1" }), // the guarded cancel UPDATE wins the (uncontested) race in this test
    });

    await syncMeetingBotIntent(supabase, provider, "m1");

    expect(cancelSpy).toHaveBeenCalledWith({
      providerBotId: created.providerBotId,
    });
  });
});

describe("processPendingBotJobs", () => {
  it("claims a pending job (flipping status out of 'pending' immediately), calls the provider, and confirms it scheduled", async () => {
    const claimSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const confirmSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    let updateCount = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1
          ? claimSpy(call.payload)
          : confirmSpy(call.payload);
      },
      meetings: meetingsHandler({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await processPendingBotJobs(
      supabase,
      new FakeMeetingBotProvider(),
      10,
    );

    expect(result).toEqual({ scheduled: 1, failed: 0 });
    // The claim itself moves status out of 'pending' — this is what makes
    // a second concurrent claim attempt impossible, not just retry_count.
    expect(claimSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "scheduled", retry_count: 1 }),
    );
    expect(confirmSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider_bot_id: expect.any(String) }),
    );
  });

  it("cancels the just-created provider bot if the job was cancelled while createBot was in flight", async () => {
    let updateCount = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        if (updateCount === 1) return ok({ id: "job-1" }); // claim succeeds
        return ok(null); // confirm loses the race — job was cancelled in the meantime
      },
      meetings: meetingsHandler({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });
    const provider = new FakeMeetingBotProvider();
    const cancelSpy = vi.spyOn(provider, "cancelBot");

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 0 });
    expect(cancelSpy).toHaveBeenCalledWith({
      providerBotId: expect.any(String),
    });
  });

  it("skips a job that a concurrent caller already claimed (optimistic lock returns no row)", async () => {
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        return ok(null); // claim update returns no row — already claimed elsewhere
      },
      meetings: meetingsHandler({ meeting_url: "https://teams.example/x" }),
    });

    const result = await processPendingBotJobs(
      supabase,
      new FakeMeetingBotProvider(),
      10,
    );

    expect(result).toEqual({ scheduled: 0, failed: 0 });
  });

  it("marks a job failed when the meeting has no join URL", async () => {
    let updateCount = 0;
    const failSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1 ? ok({ id: "job-1" }) : failSpy(call.payload);
      },
      meetings: meetingsHandler({ meeting_url: null }),
    });

    const result = await processPendingBotJobs(
      supabase,
      new FakeMeetingBotProvider(),
      10,
    );

    expect(result).toEqual({ scheduled: 0, failed: 1 });
    expect(failSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("marks a job failed when the provider throws", async () => {
    let updateCount = 0;
    const failSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1 ? ok({ id: "job-1" }) : failSpy(call.payload);
      },
      meetings: meetingsHandler({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });
    const provider = {
      name: "broken",
      createBot: vi.fn().mockRejectedValue(new Error("provider down")),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn(),
    };

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 1 });
    expect(failSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        last_error: "provider down",
      }),
    );
  });

  it("resets a rate-limited job back to pending with next_retry_at, instead of failing it", async () => {
    let updateCount = 0;
    const retrySpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1 ? ok({ id: "job-1" }) : retrySpy(call.payload);
      },
      meetings: meetingsHandler({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });
    const rateLimitError = Object.assign(new Error("rate limited"), {
      retryAfterSeconds: 30,
    });
    const provider = {
      name: "broken",
      createBot: vi.fn().mockRejectedValue(rateLimitError),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn(),
    };

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 0 });
    expect(retrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        next_retry_at: expect.any(String),
      }),
    );
  });

  // M17C follow-up: dispatch timing gate. Confirmed live that dispatching
  // the instant a meeting is eligible — regardless of how far away it
  // starts — sends the bot into an empty Teams lobby with nobody able to
  // admit it. These tests cover the new gate; every test above this one
  // covers the CAS claim / retry / cancellation behavior the gate must
  // never touch, and none of it changed.

  it("does not claim a job whose meeting is further away than the default 90s lead time", async () => {
    const provider = new FakeMeetingBotProvider();
    const createSpy = vi.spyOn(provider, "createBot");
    let botJobsUpdateCalls = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        botJobsUpdateCalls += 1;
        return ok({ id: "job-1" }); // would succeed if the claim were ever attempted
      },
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() + 10 * 60 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() + 40 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
    });

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 0 });
    expect(createSpy).not.toHaveBeenCalled();
    // The row was never touched at all — not claimed, not retried, no
    // wasted retry_count churn on a job that isn't due yet.
    expect(botJobsUpdateCalls).toBe(0);
  });

  it("claims and dispatches once the meeting is within the default 90s lead time", async () => {
    const claimSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const confirmSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    let updateCount = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1
          ? claimSpy(call.payload)
          : confirmSpy(call.payload);
      },
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() + 60 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() + 30 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await processPendingBotJobs(
      supabase,
      new FakeMeetingBotProvider(),
      10,
    );

    expect(result).toEqual({ scheduled: 1, failed: 0 });
    expect(claimSpy).toHaveBeenCalled();
  });

  it("honors a custom per-org bot_dispatch_lead_seconds instead of the default", async () => {
    const provider = new FakeMeetingBotProvider();
    const createSpy = vi.spyOn(provider, "createBot");
    let botJobsUpdateCalls = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        botJobsUpdateCalls += 1;
        return ok({ id: "job-1" });
      },
      // 60s out with this org's configured 30s lead: dispatch doesn't
      // open until 30s before start, i.e. 30s from now — not due yet. A
      // longer lead dispatches EARLIER, so if this custom (shorter) 30s
      // value were wrongly ignored in favor of the 90s default, the job
      // would incorrectly look already-due (90s lead opens at
      // now+60-90 = 30s in the past) and get dispatched.
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() + 60 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() + 30 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
      meeting_policy_sets: () =>
        ok([{ organization_id: "org-1", bot_dispatch_lead_seconds: 30 }]),
    });

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 0 });
    expect(createSpy).not.toHaveBeenCalled();
    expect(botJobsUpdateCalls).toBe(0);
  });

  it("falls back to the 90s default when the org has no meeting_policy_sets row", async () => {
    const claimSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const confirmSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    let updateCount = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1
          ? claimSpy(call.payload)
          : confirmSpy(call.payload);
      },
      // 80s out — due under the 90s default, would not be under e.g. 60s.
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() + 80 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() + 30 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
      meeting_policy_sets: () => ok([]), // no row for this org at all
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await processPendingBotJobs(
      supabase,
      new FakeMeetingBotProvider(),
      10,
    );

    expect(result).toEqual({ scheduled: 1, failed: 0 });
    expect(claimSpy).toHaveBeenCalled();
  });

  it("fails a job whose meeting has already ended, without ever calling the provider", async () => {
    const claimSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const failSpy = vi.fn((_payload?: unknown) => ok(null));
    let updateCount = 0;
    const provider = new FakeMeetingBotProvider();
    const createSpy = vi.spyOn(provider, "createBot");
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        updateCount += 1;
        return updateCount === 1
          ? claimSpy(call.payload)
          : failSpy(call.payload);
      },
      // A meeting discovered an hour after it ended — well past any
      // reasonable grace window.
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() - 60 * 60 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() - 40 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 1 });
    expect(createSpy).not.toHaveBeenCalled();
    expect(failSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        last_error: expect.stringContaining("ended"),
      }),
    );
  });

  it("uses the CURRENT scheduled_start after a reschedule, not a stale earlier value", async () => {
    // dispatch_at is deliberately never stored — it's computed fresh from
    // meetings.scheduled_start on every single call, precisely so a
    // reschedule can never leave a stale dispatch time behind. This test
    // is the regression guard for that: the job's meeting was originally
    // due (old scheduled_start 60s out, well inside the 90s default
    // lead), then got rescheduled LATER to 10 minutes out before this
    // poll ever ran. The fake `meetings` table reflects only the
    // post-reschedule row — there is no "old" value anywhere for the
    // code to accidentally read, which is exactly the property being
    // verified: if a caching bug were ever introduced, this is the test
    // that would catch it.
    const provider = new FakeMeetingBotProvider();
    const createSpy = vi.spyOn(provider, "createBot");
    let botJobsUpdateCalls = 0;
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select")
          return ok([
            {
              id: "job-1",
              meeting_id: "m1",
              organization_id: "org-1",
              idempotency_key: "m1:1",
              retry_count: 0,
            },
          ]);
        botJobsUpdateCalls += 1;
        return ok({ id: "job-1" });
      },
      // Post-reschedule state only: 10 minutes out now, not the ~60s-out
      // value that would have been due before the reschedule happened.
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(
                  Date.now() + 10 * 60 * 1000,
                ).toISOString(),
                scheduled_end: new Date(
                  Date.now() + 40 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
    });

    const result = await processPendingBotJobs(supabase, provider, 10);

    expect(result).toEqual({ scheduled: 0, failed: 0 });
    expect(createSpy).not.toHaveBeenCalled();
    expect(botJobsUpdateCalls).toBe(0);
  });

  it("dispatches at the exact boundary: now === scheduled_start - lead_seconds", async () => {
    // Deterministic, not timing-flaky: pin the clock, then construct a
    // scheduled_start that makes the boundary land on precisely the
    // millisecond under test, rather than relying on real elapsed time.
    vi.useFakeTimers();
    try {
      const now = new Date("2026-09-10T10:00:00.000Z");
      vi.setSystemTime(now);
      const leadSeconds = 90;
      // scheduled_start - lead_seconds*1000 === now, exactly.
      const scheduledStart = new Date(now.getTime() + leadSeconds * 1000);

      const claimSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
      const confirmSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
      let updateCount = 0;
      const supabase = createFakeSupabase({
        meeting_bot_jobs: (call) => {
          if (call.op === "select")
            return ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                idempotency_key: "m1:1",
                retry_count: 0,
              },
            ]);
          updateCount += 1;
          return updateCount === 1
            ? claimSpy(call.payload)
            : confirmSpy(call.payload);
        },
        meetings: (call) =>
          "in_id" in call.filters
            ? ok([
                {
                  id: "m1",
                  scheduled_start: scheduledStart.toISOString(),
                  scheduled_end: new Date(
                    scheduledStart.getTime() + 30 * 60 * 1000,
                  ).toISOString(),
                },
              ])
            : ok({ meeting_url: "https://teams.example/x" }),
        meeting_lifecycle_events: () => ok(null),
      });

      const result = await processPendingBotJobs(
        supabase,
        new FakeMeetingBotProvider(),
        10,
      );

      expect(result).toEqual({ scheduled: 1, failed: 0 });
      expect(claimSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches exactly once when provider returns scheduled and does not redispatch on next tick", async () => {
    const createBotSpy = vi.fn().mockResolvedValue({
      providerBotId: "teams/19%3Ameeting_test%40thread.v2",
      status: "scheduled",
      raw: { id: 28159, status: "requested" },
    });
    const provider: MeetingBotProvider = {
      name: "fake",
      createBot: createBotSpy,
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({ status: "scheduled", raw: {} }),
    };

    let jobStatus = "pending";
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) => {
        if (call.op === "select") {
          return ok(
            jobStatus === "pending"
              ? [
                  {
                    id: "job-1",
                    meeting_id: "m1",
                    organization_id: "org-1",
                    idempotency_key: "m1:1",
                    retry_count: 0,
                  },
                ]
              : [],
          );
        }
        if (call.op === "update") {
          const payload = call.payload as Record<string, unknown>;
          if (payload.status) {
            jobStatus = payload.status as string;
          }
          return ok({ id: "job-1" });
        }
        return ok(null);
      },
      meetings: (call) =>
        "in_id" in call.filters
          ? ok([
              {
                id: "m1",
                scheduled_start: new Date(Date.now() + 60 * 1000).toISOString(),
                scheduled_end: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
              },
            ])
          : ok({ meeting_url: "https://teams.example/x" }),
      meeting_lifecycle_events: () => ok(null),
    });

    // Tick 1: Job is pending -> provider.createBot is called
    const tick1 = await processPendingBotJobs(supabase, provider, 10);
    expect(tick1).toEqual({ scheduled: 1, failed: 0 });
    expect(createBotSpy).toHaveBeenCalledTimes(1);
    expect(jobStatus).toBe("scheduled");

    // Intervening sync: syncBotStatuses runs with provider reporting scheduled
    await syncBotStatuses(supabase, provider, 10);
    expect(jobStatus).toBe("scheduled");

    // Tick 2: Next worker tick runs processPendingBotJobs
    const tick2 = await processPendingBotJobs(supabase, provider, 10);
    expect(tick2).toEqual({ scheduled: 0, failed: 0 });
    expect(createBotSpy).toHaveBeenCalledTimes(1); // Invocation count remains strictly 1
  });
});

describe("syncBotStatuses", () => {
  it("updates our row when the provider reports a status change", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const provider = {
      name: "fake",
      createBot: vi.fn(),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({
        status: "joined",
        joinedAt: "2026-01-01T00:00:00Z",
        raw: {},
      }),
    };
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                provider_bot_id: "bot-1",
                status: "scheduled",
              },
            ])
          : updateSpy(call.payload),
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await syncBotStatuses(supabase, provider, 10);

    expect(result).toEqual({ updated: 1 });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "joined",
        joined_at: "2026-01-01T00:00:00Z",
      }),
    );
  });

  it("does not mark a just-scheduled job completed if the provider hasn't propagated it yet (grace period)", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok(null));
    const provider = {
      name: "fake",
      createBot: vi.fn(),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({ status: "completed", raw: {} }),
    };
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                provider_bot_id: "bot-1",
                status: "scheduled",
                scheduled_at: new Date().toISOString(),
              },
            ])
          : updateSpy(call.payload),
    });

    const result = await syncBotStatuses(supabase, provider, 10);

    expect(result).toEqual({ updated: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("does mark a scheduled job completed once the grace period has passed", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok({ id: "job-1" }));
    const provider = {
      name: "fake",
      createBot: vi.fn(),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({ status: "completed", raw: {} }),
    };
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                provider_bot_id: "bot-1",
                status: "scheduled",
                scheduled_at: new Date(
                  Date.now() - 10 * 60 * 1000,
                ).toISOString(),
              },
            ])
          : updateSpy(call.payload),
      meeting_lifecycle_events: () => ok(null),
    });

    const result = await syncBotStatuses(supabase, provider, 10);

    expect(result).toEqual({ updated: 1 });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("does nothing when the provider status matches what we already have", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok(null));
    const provider = {
      name: "fake",
      createBot: vi.fn(),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({ status: "scheduled", raw: {} }),
    };
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                provider_bot_id: "bot-1",
                status: "scheduled",
              },
            ])
          : updateSpy(call.payload),
    });

    const result = await syncBotStatuses(supabase, provider, 10);

    expect(result).toEqual({ updated: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("never demotes a scheduled, joining, or joined job back to pending", async () => {
    const updateSpy = vi.fn((_payload?: unknown) => ok(null));
    const provider = {
      name: "fake",
      createBot: vi.fn(),
      cancelBot: vi.fn(),
      getBotStatus: vi.fn().mockResolvedValue({ status: "pending", raw: {} }),
    };
    const supabase = createFakeSupabase({
      meeting_bot_jobs: (call) =>
        call.op === "select"
          ? ok([
              {
                id: "job-1",
                meeting_id: "m1",
                organization_id: "org-1",
                provider_bot_id: "bot-1",
                status: "scheduled",
              },
            ])
          : updateSpy(call.payload),
    });

    const result = await syncBotStatuses(supabase, provider, 10);

    expect(result).toEqual({ updated: 0 });
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
