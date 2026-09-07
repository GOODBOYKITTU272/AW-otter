import { describe, expect, it, vi } from "vitest";
import { FakeMeetingBotProvider } from "@applywizz/meeting-bots";
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
      botName: "ApplyWizz Meeting Assistant",
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
      meetings: () => ok({ meeting_url: "https://teams.example/x" }),
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
      meetings: () => ok({ meeting_url: "https://teams.example/x" }),
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
      meetings: () => ok(null),
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
      meetings: () => ok({ meeting_url: null }),
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
      meetings: () => ok({ meeting_url: "https://teams.example/x" }),
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
      meetings: () => ok({ meeting_url: "https://teams.example/x" }),
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
});
