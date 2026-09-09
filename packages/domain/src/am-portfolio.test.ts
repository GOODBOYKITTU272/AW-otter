import { describe, expect, it } from "vitest";
import {
  calendarDayOffset,
  computeAttention,
  getOrgTodayRange,
  getPortfolioActionQueue,
  getPortfolioOverview,
  relativeDayLabel,
  type AppSupabaseClient,
} from "./am-portfolio";

interface Row {
  [key: string]: unknown;
}

function fakeSupabase(tables: Record<string, Row[]>) {
  let queryCount = 0;
  function from(table: string) {
    queryCount++;
    const rows = tables[table] ?? [];
    let filtered = [...rows];
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, value: unknown) {
        filtered = filtered.filter((r) => r[col] === value);
        return builder;
      },
      neq(col: string, value: unknown) {
        filtered = filtered.filter((r) => r[col] !== value);
        return builder;
      },
      lt(col: string, value: unknown) {
        filtered = filtered.filter(
          (r) => r[col] !== null && r[col] !== undefined && r[col]! < value!,
        );
        return builder;
      },
      gte(col: string, value: unknown) {
        filtered = filtered.filter(
          (r) => r[col] !== null && r[col] !== undefined && r[col]! >= value!,
        );
        return builder;
      },
      lte(col: string, value: unknown) {
        filtered = filtered.filter(
          (r) => r[col] !== null && r[col] !== undefined && r[col]! <= value!,
        );
        return builder;
      },
      in(col: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[col]));
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        ascending = opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        const result = apply();
        return { data: result[0] ?? null, error: null };
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        return Promise.resolve({ data: apply(), error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };

    function apply() {
      let result = filtered;
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) result = result.slice(0, limitN);
      return result;
    }

    return builder;
  }
  return {
    from,
    queryCountRef: () => queryCount,
  } as unknown as AppSupabaseClient & {
    queryCountRef: () => number;
  };
}

describe("calendarDayOffset", () => {
  it("returns 0 for a time later the SAME day (Codex-independent regression: the reported 'today vs in 1 day' bug)", () => {
    // 9am today vs 11:59pm today, US/Eastern — a naive millisecond-based
    // Math.ceil() would return 1 for anything more than a few hours away.
    const from = new Date("2026-09-09T13:00:00.000Z"); // 9am US/Eastern
    const to = new Date("2026-09-09T23:00:00.000Z"); // 7pm US/Eastern, same day
    expect(calendarDayOffset("America/New_York", from, to)).toBe(0);
  });

  it("returns 1 for tomorrow, even close to midnight", () => {
    const from = new Date("2026-09-09T13:00:00.000Z"); // 9am US/Eastern
    const to = new Date("2026-09-10T05:00:00.000Z"); // 1am US/Eastern next day
    expect(calendarDayOffset("America/New_York", from, to)).toBe(1);
  });

  it("returns -1 for yesterday", () => {
    const from = new Date("2026-09-09T13:00:00.000Z");
    const to = new Date("2026-09-08T13:00:00.000Z");
    expect(calendarDayOffset("America/New_York", from, to)).toBe(-1);
  });
});

describe("relativeDayLabel", () => {
  it("labels 0 as 'today', 1 as 'tomorrow', and N as 'in N days'", () => {
    expect(relativeDayLabel(0)).toBe("today");
    expect(relativeDayLabel(1)).toBe("tomorrow");
    expect(relativeDayLabel(5)).toBe("in 5 days");
  });
});

describe("getOrgTodayRange", () => {
  it("returns a 24h window covering the given instant in the target timezone", () => {
    const now = new Date("2026-09-09T13:00:00.000Z");
    const range = getOrgTodayRange("America/New_York", now);
    expect(new Date(range.startUtc).getTime()).toBeLessThanOrEqual(
      now.getTime(),
    );
    expect(new Date(range.endUtc).getTime()).toBeGreaterThanOrEqual(
      now.getTime(),
    );
    expect(
      new Date(range.endUtc).getTime() - new Date(range.startUtc).getTime(),
    ).toBeCloseTo(24 * 3600 * 1000 - 1, -2);
  });

  it("is correct across a real US DST spring-forward transition (Codex Pass 2 regression)", () => {
    // America/New_York, 2026-03-08: clocks jump 2am -> 3am (EST -> EDT).
    // The old implementation reused one offset (computed from `now`) for
    // both boundaries, producing a wrong start-of-day whenever `now` and
    // midnight fall on opposite sides of the transition.
    const now = new Date("2026-03-08T18:00:00.000Z"); // 1pm EDT, after the jump
    const range = getOrgTodayRange("America/New_York", now);
    expect(range.startUtc).toBe("2026-03-08T05:00:00.000Z");
    expect(range.endUtc).toBe("2026-03-09T03:59:59.999Z");
  });

  it("is exact on a normal (non-DST-transition) day, including the millisecond boundary", () => {
    const now = new Date("2026-06-15T18:00:00.000Z");
    const range = getOrgTodayRange("America/New_York", now);
    expect(range.startUtc).toBe("2026-06-15T04:00:00.000Z");
    expect(range.endUtc).toBe("2026-06-16T03:59:59.999Z");
  });
});

describe("computeAttention", () => {
  const now = new Date("2026-09-09T13:00:00.000Z");
  const base = {
    timezone: "UTC",
    overdueActions: [],
    blockers: [],
    dueTodayOrSoonCount: 0,
    serviceEndDaysAway: null,
    hasUnresolvedFromPriorMeetingForTodayCall: null,
    nextCall: null,
    pendingTruthCount: 0,
    failedIntelligenceCount: 0,
    now,
  };

  it("never fabricates a reason — a customer with no signals is 'normal' with empty reasons", () => {
    const result = computeAttention(base);
    expect(result.level).toBe("normal");
    expect(result.reasons).toEqual([]);
  });

  it("flags an overdue action as HIGH with a real day-count label", () => {
    const result = computeAttention({
      ...base,
      overdueActions: [
        {
          id: "r1",
          description: "Send revised resume",
          recordType: "action_item",
          dueAt: "2026-09-07T13:00:00.000Z",
        },
      ],
    });
    expect(result.level).toBe("high");
    expect(result.reasons[0]?.code).toBe("overdue_action");
    expect(result.reasons[0]?.label).toContain("Send revised resume");
    expect(result.reasons[0]?.label).toContain("overdue by 2 days");
  });

  it("flags a blocker as HIGH", () => {
    const result = computeAttention({
      ...base,
      blockers: [
        {
          id: "b1",
          description: "Sponsorship unresolved",
          recordType: "blocker",
          dueAt: null,
        },
      ],
    });
    expect(result.level).toBe("high");
    expect(result.reasons.some((r) => r.code === "unresolved_blocker")).toBe(
      true,
    );
  });

  it("flags service end within 7 days as HIGH, within 14 as MEDIUM, and neither beyond 14", () => {
    expect(computeAttention({ ...base, serviceEndDaysAway: 5 }).level).toBe(
      "high",
    );
    expect(computeAttention({ ...base, serviceEndDaysAway: 12 }).level).toBe(
      "medium",
    );
    expect(computeAttention({ ...base, serviceEndDaysAway: 25 }).level).toBe(
      "normal",
    );
  });

  it("flags a call today with an unresolved prior item as HIGH", () => {
    const result = computeAttention({
      ...base,
      hasUnresolvedFromPriorMeetingForTodayCall: { callType: "progress" },
    });
    expect(result.level).toBe("high");
    expect(result.reasons[0]?.label).toContain("today with an unresolved item");
  });

  it("flags due-soon actions as MEDIUM only", () => {
    const result = computeAttention({ ...base, dueTodayOrSoonCount: 2 });
    expect(result.level).toBe("medium");
    expect(result.reasons[0]?.code).toBe("due_soon_action");
  });

  it("labels a call happening later TODAY as 'today', not 'in 1 day' (the exact reported regression)", () => {
    const result = computeAttention({
      ...base,
      nextCall: {
        callType: "discovery",
        scheduledAt: "2026-09-09T20:00:00.000Z",
        meetingId: "m1",
      },
    });
    expect(result.reasons[0]?.label).toBe("Discovery call today");
    expect(result.reasons[0]?.label).not.toContain("in 1 day");
  });

  it("labels a call tomorrow as 'tomorrow'", () => {
    const result = computeAttention({
      ...base,
      nextCall: {
        callType: "resume_review",
        scheduledAt: "2026-09-10T13:00:00.000Z",
        meetingId: "m1",
      },
    });
    expect(result.reasons[0]?.label).toBe("Resume Review call tomorrow");
  });

  it("flags pending truth changes as MEDIUM only (never HIGH — no 'blocking' heuristic is invented)", () => {
    const result = computeAttention({ ...base, pendingTruthCount: 3 });
    expect(result.level).toBe("medium");
    expect(result.reasons[0]?.code).toBe("pending_truth_change");
  });

  it("flags a failed intelligence run as MEDIUM with a real count label (restores the M11 operational signal Codex found missing — regression)", () => {
    const result = computeAttention({ ...base, failedIntelligenceCount: 2 });
    expect(result.level).toBe("medium");
    expect(result.reasons[0]?.code).toBe("ai_processing_failed");
    expect(result.reasons[0]?.label).toBe(
      "2 calls failed intelligence processing",
    );
  });

  it("overall level is the HIGHEST among all applicable reasons, and every reason is listed (not just the highest)", () => {
    const result = computeAttention({
      ...base,
      overdueActions: [
        {
          id: "r1",
          description: "X",
          recordType: "action_item",
          dueAt: "2026-09-07T13:00:00.000Z",
        },
      ],
      pendingTruthCount: 1,
    });
    expect(result.level).toBe("high");
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons.map((r) => r.code).sort()).toEqual([
      "overdue_action",
      "pending_truth_change",
    ]);
  });
});

describe("getPortfolioOverview", () => {
  it("never counts a RESCHEDULED scheduler_calls row as today's call, last call, or an unresolved-commitment trigger (Codex Pass 2 regression)", async () => {
    const nowIso = new Date().toISOString();
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [
        { id: "cust-1", name: "Rescheduled Customer", lifecycle_stage: null },
      ],
      scheduler_calls: [
        {
          customer_id: "cust-1",
          canonical_call_type: "progress",
          scheduled_at: nowIso,
          external_status: "RESCHEDULED",
          meeting_id: "meeting-stale",
        },
      ],
      meetings: [],
      call_records: [
        {
          id: "cr1",
          customer_id: "cust-1",
          meeting_id: "meeting-old",
          record_type: "action_item",
          status: "detected",
          description: "Old open item",
          due_at: null,
          completed_at: null,
        },
      ],
      customer_truth_facts: [],
      customer_context_snapshots: [],
    });
    const result = await getPortfolioOverview(supabase, "org-1");
    const row = result[0]!;
    expect(row.isCallToday).toBe(false);
    expect(row.todaysCalls).toEqual([]);
    expect(row.lastCall).toBeNull();
    expect(row.nextCall).toBeNull();
    expect(
      row.attention.reasons.some(
        (r) => r.code === "call_today_unresolved_commitment",
      ),
    ).toBe(false);
  });

  it("returns an empty list when the caller has no visible customers, without erroring", async () => {
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [],
    });
    const result = await getPortfolioOverview(supabase, "org-1");
    expect(result).toEqual([]);
  });

  it("composes correct counts/next-last-call/attention for a real portfolio row, using a fixed small number of queries (no N+1)", async () => {
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [
        { id: "cust-1", name: "Test Customer", lifecycle_stage: "Progress" },
      ],
      scheduler_calls: [
        {
          customer_id: "cust-1",
          canonical_call_type: "progress",
          scheduled_at: "2099-01-01T00:00:00Z",
          external_status: "SCHEDULED",
          meeting_id: "meeting-future",
        },
        {
          customer_id: "cust-1",
          canonical_call_type: "discovery",
          scheduled_at: "2020-01-01T00:00:00Z",
          external_status: "COMPLETED",
          meeting_id: "meeting-past",
        },
      ],
      meetings: [
        {
          id: "meeting-past",
          customer_id: "cust-1",
          scheduled_start: "2020-01-01T00:00:00Z",
        },
      ],
      call_records: [
        {
          id: "cr1",
          customer_id: "cust-1",
          meeting_id: "meeting-past",
          record_type: "action_item",
          status: "detected",
          description: "Overdue thing",
          due_at: "2020-01-02T00:00:00Z",
          completed_at: null,
        },
        {
          id: "cr2",
          customer_id: "cust-1",
          meeting_id: "meeting-past",
          record_type: "blocker",
          status: "detected",
          description: "A blocker",
          due_at: null,
          completed_at: null,
        },
      ],
      customer_truth_facts: [
        { customer_id: "cust-1", status: "proposed", confirmed_at: null },
      ],
      customer_context_snapshots: [],
    });

    const result = await getPortfolioOverview(supabase, "org-1");
    expect(result).toHaveLength(1);
    const row = result[0]!;
    expect(row.name).toBe("Test Customer");
    expect(row.nextCall?.callType).toBe("progress");
    expect(row.lastCall?.callType).toBe("discovery");
    expect(row.overdueActionCount).toBe(1);
    expect(row.openBlockerCount).toBe(1);
    expect(row.pendingTruthCount).toBe(1);
    expect(row.attention.level).toBe("high");

    // Query-count assertion: a fixed handful of batched queries regardless
    // of portfolio size — never a per-customer loop.
    const withQueryCount = supabase as unknown as {
      queryCountRef: () => number;
    };
    expect(withQueryCount.queryCountRef()).toBeLessThanOrEqual(8);
  });

  it("exposes serviceEndDaysAway on the row (Codex-independent-review fix: single source of truth for the day-count, no page-level re-derivation)", async () => {
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [
        { id: "cust-1", name: "Test Customer", lifecycle_stage: null },
      ],
      scheduler_calls: [],
      meetings: [],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [
        {
          customer_id: "cust-1",
          normalized_data: {
            context: { service_end: "2026-09-12" },
            truthFields: {},
          },
          created_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
    const result = await getPortfolioOverview(supabase, "org-1");
    expect(result[0]!.serviceEndDaysAway).not.toBeNull();
    expect(typeof result[0]!.serviceEndDaysAway).toBe("number");
  });

  it("surfaces a failed ai_runs row as the customer's ai_processing_failed attention reason, scoped only to that customer's own meetings (Codex-independent-review fix: restores M11's dropped operational signal)", async () => {
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [
        { id: "cust-1", name: "Customer With Failure", lifecycle_stage: null },
        {
          id: "cust-2",
          name: "Customer Without Failure",
          lifecycle_stage: null,
        },
      ],
      scheduler_calls: [],
      meetings: [
        {
          id: "meeting-1",
          customer_id: "cust-1",
          scheduled_start: "2026-01-01T00:00:00Z",
        },
        {
          id: "meeting-2",
          customer_id: "cust-2",
          scheduled_start: "2026-01-01T00:00:00Z",
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [],
      ai_runs: [
        { id: "run-1", meeting_id: "meeting-1", status: "failed" },
        { id: "run-2", meeting_id: "meeting-2", status: "completed" },
      ],
    });
    const result = await getPortfolioOverview(supabase, "org-1");
    const withFailure = result.find((r) => r.customerId === "cust-1")!;
    const withoutFailure = result.find((r) => r.customerId === "cust-2")!;

    expect(
      withFailure.attention.reasons.some(
        (r) => r.code === "ai_processing_failed",
      ),
    ).toBe(true);
    expect(
      withoutFailure.attention.reasons.some(
        (r) => r.code === "ai_processing_failed",
      ),
    ).toBe(false);
  });

  it("does not scale query count with portfolio size (10 customers still issue the same fixed query count as 1)", async () => {
    const customers = Array.from({ length: 10 }, (_, i) => ({
      id: `cust-${i}`,
      name: `Customer ${i}`,
      lifecycle_stage: null,
    }));
    const supabase = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers,
      scheduler_calls: [],
      meetings: [],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [],
    });
    await getPortfolioOverview(supabase, "org-1");
    const withQueryCount = supabase as unknown as {
      queryCountRef: () => number;
    };
    const countFor10 = withQueryCount.queryCountRef();

    const supabase1 = fakeSupabase({
      organizations: [{ id: "org-1", timezone: "UTC" }],
      customers: [customers[0]!],
      scheduler_calls: [],
      meetings: [],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [],
    });
    await getPortfolioOverview(supabase1, "org-1");
    const countFor1 = (
      supabase1 as unknown as { queryCountRef: () => number }
    ).queryCountRef();

    expect(countFor10).toBe(countFor1);
  });
});

describe("getPortfolioActionQueue", () => {
  const now = new Date("2026-09-09T13:00:00.000Z");

  it("a large overdue backlog (>30 records) never hides genuinely near-term due-today/due-soon items (Codex-independent-review #1 regression: the old single-cap query could crowd them out)", async () => {
    const overdueRows = Array.from({ length: 35 }, (_, i) => ({
      id: `overdue-${i}`,
      record_type: "action_item",
      description: `Old overdue item ${i}`,
      due_at: `2020-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      customer_id: "cust-1",
      status: "detected",
    }));
    const dueTodayRow = {
      id: "due-today-1",
      record_type: "commitment",
      description: "Genuinely due today",
      due_at: "2026-09-09T15:00:00.000Z",
      customer_id: "cust-1",
      status: "detected",
    };
    const dueSoonRow = {
      id: "due-soon-1",
      record_type: "commitment",
      description: "Due in 3 days",
      due_at: "2026-09-12T13:00:00.000Z",
      customer_id: "cust-1",
      status: "detected",
    };
    const supabase = fakeSupabase({
      call_records: [...overdueRows, dueTodayRow, dueSoonRow],
    });

    const queue = await getPortfolioActionQueue(supabase, "UTC", now);

    expect(queue.overdue.length).toBeLessThanOrEqual(30);
    expect(queue.dueToday.some((r) => r.id === "due-today-1")).toBe(true);
    expect(queue.dueSoon.some((r) => r.id === "due-soon-1")).toBe(true);
  });

  it("excludes blockers from overdue/due-soon buckets — they already have their own attention representation (Codex-independent-review #4 regression: prevents double-counting)", async () => {
    const supabase = fakeSupabase({
      call_records: [
        {
          id: "blocker-1",
          record_type: "blocker",
          description: "Overdue blocker",
          due_at: "2020-01-01T00:00:00.000Z",
          customer_id: "cust-1",
          status: "detected",
        },
        {
          id: "blocker-2",
          record_type: "blocker",
          description: "Due-soon blocker",
          due_at: "2026-09-10T00:00:00.000Z",
          customer_id: "cust-1",
          status: "detected",
        },
      ],
    });

    const queue = await getPortfolioActionQueue(supabase, "UTC", now);

    expect(queue.overdue).toEqual([]);
    expect(queue.dueToday).toEqual([]);
    expect(queue.dueSoon).toEqual([]);
  });

  it("buckets due-today vs due-soon using org-timezone calendar-day boundaries, not raw millisecond math", async () => {
    const supabase = fakeSupabase({
      call_records: [
        {
          id: "later-today",
          record_type: "action_item",
          description: "Later today",
          due_at: "2026-09-09T23:00:00.000Z",
          customer_id: "cust-1",
          status: "detected",
        },
      ],
    });

    const queue = await getPortfolioActionQueue(supabase, "UTC", now);
    expect(queue.dueToday.map((r) => r.id)).toEqual(["later-today"]);
    expect(queue.dueSoon).toEqual([]);
  });
});
