import { describe, expect, it } from "vitest";
import { getOperationalHealth, type AppSupabaseClient } from "./operations";

interface Row {
  [key: string]: unknown;
}

function fakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
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
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
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
        return Promise.resolve({ data: result, error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }
  return { from } as unknown as AppSupabaseClient;
}

const ORG = "org-1";
const now = new Date();
const recent = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
const stale = new Date(now.getTime() - 45 * 60 * 1000).toISOString();

describe("getOperationalHealth", () => {
  it("classifies an active row updated recently as neither failed nor stuck", async () => {
    const supabase = fakeSupabase({
      calendar_event_jobs: [
        {
          id: "c1",
          organization_id: ORG,
          external_event_id: "evt-1",
          status: "processing",
          last_error: null,
          updated_at: recent,
        },
      ],
      meeting_transcripts: [],
      ai_runs: [],
      meeting_bot_jobs: [],
    });
    const health = await getOperationalHealth(supabase, ORG);
    const calendar = health.find((h) => h.queue === "Calendar sync")!;
    expect(calendar.failedCount).toBe(0);
    expect(calendar.stuckCount).toBe(0);
  });

  it("flags an active row whose updated_at is stale as stuck, not failed", async () => {
    const supabase = fakeSupabase({
      calendar_event_jobs: [
        {
          id: "c1",
          organization_id: ORG,
          external_event_id: "evt-1",
          status: "processing",
          last_error: null,
          updated_at: stale,
        },
      ],
      meeting_transcripts: [],
      ai_runs: [],
      meeting_bot_jobs: [],
    });
    const health = await getOperationalHealth(supabase, ORG);
    const calendar = health.find((h) => h.queue === "Calendar sync")!;
    expect(calendar.stuckCount).toBe(1);
    expect(calendar.failedCount).toBe(0);
    expect(calendar.stuck[0]!.id).toBe("c1");
  });

  it("counts a genuinely failed row as failed regardless of how stale it is (never double-counted as stuck)", async () => {
    const supabase = fakeSupabase({
      calendar_event_jobs: [
        {
          id: "c1",
          organization_id: ORG,
          external_event_id: "evt-1",
          status: "dead_letter",
          last_error: "boom",
          updated_at: stale,
        },
      ],
      meeting_transcripts: [],
      ai_runs: [],
      meeting_bot_jobs: [],
    });
    const health = await getOperationalHealth(supabase, ORG);
    const calendar = health.find((h) => h.queue === "Calendar sync")!;
    expect(calendar.failedCount).toBe(1);
    expect(calendar.stuckCount).toBe(0);
    expect(calendar.failed[0]!.errorSummary).toBe("boom");
  });

  it("scopes to the given organization only, even with rows from another org present", async () => {
    const supabase = fakeSupabase({
      calendar_event_jobs: [
        {
          id: "mine",
          organization_id: ORG,
          external_event_id: "evt-1",
          status: "failed",
          last_error: "x",
          updated_at: recent,
        },
        {
          id: "other-org",
          organization_id: "org-2",
          external_event_id: "evt-2",
          status: "failed",
          last_error: "x",
          updated_at: recent,
        },
      ],
      meeting_transcripts: [],
      ai_runs: [],
      meeting_bot_jobs: [],
    });
    const health = await getOperationalHealth(supabase, ORG);
    const calendar = health.find((h) => h.queue === "Calendar sync")!;
    expect(calendar.failedCount).toBe(1);
    expect(calendar.failed[0]!.id).toBe("mine");
  });

  it("returns all four queues even when every one is empty", async () => {
    const supabase = fakeSupabase({
      calendar_event_jobs: [],
      meeting_transcripts: [],
      ai_runs: [],
      meeting_bot_jobs: [],
    });
    const health = await getOperationalHealth(supabase, ORG);
    expect(health.map((h) => h.queue)).toEqual([
      "Calendar sync",
      "Transcription",
      "Meeting intelligence",
      "Meeting bot",
    ]);
    for (const h of health) {
      expect(h.failedCount).toBe(0);
      expect(h.stuckCount).toBe(0);
    }
  });
});
