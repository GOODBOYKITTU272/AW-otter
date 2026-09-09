import { describe, expect, it } from "vitest";
import { FakeMeetingBotProvider } from "@applywizz/meeting-bots";
import {
  recoverStuckJobs,
  syncIncidentsWithCurrentState,
  type AppSupabaseClient,
} from "./operations-recovery";

interface Row {
  [key: string]: unknown;
}

// Same fake shape as operational-incidents.test.ts: SELECT returns deep
// copies (so a caller's local `row` variable is a frozen snapshot,
// matching real Supabase semantics), UPDATE/INSERT mutate the live
// canonical array filtered against its *current* values. This is what
// makes the CAS/concurrency test below meaningful — a second caller's
// stale `.eq("updated_at", row.updated_at)` predicate genuinely stops
// matching once a first caller's update has already landed. `.rpc()`
// simulates record_operational_incident's real atomic upsert-or-bump
// (insert .. on conflict .. do update set occurrence_count = +1) against
// the in-memory table, matching what the real SQL function does.
function fakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let insertRow: Row = {};
    let filtered = rows;

    const builder = {
      select() {
        return builder;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        return builder;
      },
      insert(p: Row) {
        mode = "insert";
        insertRow = p;
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      lt(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] as string) < (val as string));
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      is(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] ?? null) === val);
        return builder;
      },
      order() {
        return builder;
      },
      async maybeSingle() {
        if (mode === "update") {
          if (filtered.length === 0) return { data: null, error: null };
          Object.assign(filtered[0]!, patch);
          return { data: { id: filtered[0]!.id }, error: null };
        }
        return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        let result: { data: unknown; error: unknown };
        if (mode === "update") {
          for (const row of filtered) Object.assign(row, patch);
          result = { data: filtered.map((r) => ({ id: r.id })), error: null };
        } else if (mode === "insert") {
          const created: Row = {
            id: `gen-${rows.length + 1}`,
            occurrence_count: 1,
            resolved_at: null,
            ...insertRow,
          };
          rows.push(created);
          result = { data: created, error: null };
        } else {
          result = { data: filtered.map((r) => ({ ...r })), error: null };
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (fn !== "record_operational_incident") {
      throw new Error(`fakeSupabase.rpc: unexpected function ${fn}`);
    }
    const table = tables.operational_incidents ?? (tables.operational_incidents = []);
    const existing = table.find(
      (r) =>
        r.organization_id === args.p_organization_id &&
        r.queue === args.p_queue &&
        r.entity_id === args.p_entity_id &&
        r.incident_type === args.p_incident_type &&
        (r.resolved_at ?? null) === null,
    );
    if (existing) {
      existing.occurrence_count = (existing.occurrence_count as number) + 1;
      existing.last_seen_at = new Date().toISOString();
    } else {
      table.push({
        id: `gen-incident-${table.length + 1}`,
        organization_id: args.p_organization_id,
        queue: args.p_queue,
        entity_id: args.p_entity_id,
        incident_type: args.p_incident_type,
        severity: args.p_severity,
        reason: args.p_reason,
        meeting_id: args.p_meeting_id ?? null,
        occurrence_count: 1,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        resolved_at: null,
      });
    }
    return { data: null, error: null };
  }

  return { from, rpc } as unknown as AppSupabaseClient;
}

const ORG = "org-1";
const now = Date.now();
const stale = new Date(now - 45 * 60 * 1000).toISOString();
const recent = new Date(now - 5 * 60 * 1000).toISOString();

function emptyTables(overrides: Partial<Record<string, Row[]>> = {}) {
  return {
    calendar_event_jobs: [],
    meeting_transcripts: [],
    ai_runs: [],
    meeting_bot_jobs: [],
    operational_incidents: [],
    ...overrides,
  } as Record<string, Row[]>;
}

describe("recoverStuckJobs", () => {
  it("recovers an eligible stuck transcription job: status reverts, retry_count bumps, an incident is recorded", async () => {
    const tables = emptyTables({
      meeting_transcripts: [
        {
          id: "t1",
          organization_id: ORG,
          meeting_id: "m1",
          processing_status: "processing",
          retry_count: 0,
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const results = await recoverStuckJobs(
      supabase,
      new FakeMeetingBotProvider(),
      ORG,
    );

    const transcription = results.find((r) => r.queue === "transcription")!;
    expect(transcription.recovered).toBe(1);
    expect(transcription.terminated).toBe(0);
    expect(tables.meeting_transcripts![0]!.processing_status).toBe("retryable");
    expect(tables.meeting_transcripts![0]!.retry_count).toBe(1);
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.incident_type).toBe("stuck");
  });

  it("leaves a recently-updated active job untouched", async () => {
    const tables = emptyTables({
      meeting_transcripts: [
        {
          id: "t1",
          organization_id: ORG,
          meeting_id: "m1",
          processing_status: "processing",
          retry_count: 0,
          updated_at: recent,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const results = await recoverStuckJobs(
      supabase,
      new FakeMeetingBotProvider(),
      ORG,
    );

    const transcription = results.find((r) => r.queue === "transcription")!;
    expect(transcription.recovered).toBe(0);
    expect(tables.meeting_transcripts![0]!.processing_status).toBe("processing");
    expect(tables.operational_incidents).toHaveLength(0);
  });

  it("moves a stuck job to terminal (not retried) once it has exhausted MAX_RETRY_COUNT, and the full sweep+sync produces exactly ONE open incident (review fix 1)", async () => {
    const tables = emptyTables({
      ai_runs: [
        {
          id: "a1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "running",
          retry_count: 4, // next attempt = 5 = MAX_RETRY_COUNT -> terminal
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const results = await recoverStuckJobs(
      supabase,
      new FakeMeetingBotProvider(),
      ORG,
    );

    const intelligence = results.find((r) => r.queue === "meeting_intelligence")!;
    expect(intelligence.recovered).toBe(0);
    expect(intelligence.terminated).toBe(1);
    expect(tables.ai_runs![0]!.status).toBe("failed");
    expect(tables.ai_runs![0]!.next_retry_at).toBeNull();
    // recoverStuckJobs alone (review fix 1) must NOT record an incident —
    // syncIncidentsWithCurrentState is the sole canonical source.
    expect(tables.operational_incidents).toHaveLength(0);

    await syncIncidentsWithCurrentState(supabase, ORG);

    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.incident_type).toBe("terminal_failure");
    expect(tables.operational_incidents![0]!.severity).toBe("critical");
  });

  it("does not touch a row that is already in a terminal state, however stale", async () => {
    const tables = emptyTables({
      calendar_event_jobs: [
        {
          id: "c1",
          organization_id: ORG,
          status: "dead_letter",
          attempts: 5,
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const results = await recoverStuckJobs(
      supabase,
      new FakeMeetingBotProvider(),
      ORG,
    );

    const calendar = results.find((r) => r.queue === "calendar_sync")!;
    expect(calendar.recovered).toBe(0);
    expect(calendar.terminated).toBe(0);
    expect(tables.calendar_event_jobs![0]!.status).toBe("dead_letter");
  });

  it("is idempotent: running the sweep twice only recovers the job once (bot job with no provider_bot_id yet)", async () => {
    const tables = emptyTables({
      meeting_bot_jobs: [
        {
          id: "b1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "joining",
          retry_count: 0,
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const provider = new FakeMeetingBotProvider();

    const first = await recoverStuckJobs(supabase, provider, ORG);
    expect(first.find((r) => r.queue === "meeting_bot")!.recovered).toBe(1);

    const second = await recoverStuckJobs(supabase, provider, ORG);
    expect(second.find((r) => r.queue === "meeting_bot")!.recovered).toBe(0);
    expect(second.find((r) => r.queue === "meeting_bot")!.terminated).toBe(0);
  });

  it("two concurrent recovery calls cannot both recover the same job (CAS predicate loses the race)", async () => {
    const tables = emptyTables({
      meeting_transcripts: [
        {
          id: "t1",
          organization_id: ORG,
          meeting_id: "m1",
          processing_status: "processing",
          retry_count: 0,
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const provider = new FakeMeetingBotProvider();

    const [a, b] = await Promise.all([
      recoverStuckJobs(supabase, provider, ORG),
      recoverStuckJobs(supabase, provider, ORG),
    ]);
    const totalRecovered =
      a.find((r) => r.queue === "transcription")!.recovered +
      b.find((r) => r.queue === "transcription")!.recovered;

    expect(totalRecovered).toBe(1);
    expect(tables.meeting_transcripts![0]!.retry_count).toBe(1);
    expect(tables.operational_incidents).toHaveLength(1);
  });

  it("scopes recovery to the given organization only", async () => {
    const tables = emptyTables({
      calendar_event_jobs: [
        {
          id: "mine",
          organization_id: ORG,
          status: "processing",
          attempts: 0,
          updated_at: stale,
        },
        {
          id: "other-org",
          organization_id: "org-2",
          status: "processing",
          attempts: 0,
          updated_at: stale,
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const results = await recoverStuckJobs(
      supabase,
      new FakeMeetingBotProvider(),
      ORG,
    );

    const calendar = results.find((r) => r.queue === "calendar_sync")!;
    expect(calendar.recovered).toBe(1);
    const otherOrgRow = tables.calendar_event_jobs!.find((r) => r.id === "other-org")!;
    expect(otherOrgRow.status).toBe("processing");
  });
});

describe("recoverStuckJobs — meeting bot provider-side safety (review fix 4)", () => {
  it("stale bot + provider confirms still joining/joined -> left completely untouched, no incident", async () => {
    const tables = emptyTables({
      meeting_bot_jobs: [
        {
          id: "b1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "joining",
          retry_count: 0,
          updated_at: stale,
          provider_bot_id: "bot-alive",
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const provider = new FakeMeetingBotProvider();
    provider.advanceTo("bot-alive", "joining");

    const results = await recoverStuckJobs(supabase, provider, ORG);

    const bot = results.find((r) => r.queue === "meeting_bot")!;
    expect(bot.recovered).toBe(0);
    expect(bot.terminated).toBe(0);
    expect(tables.meeting_bot_jobs![0]!.status).toBe("joining");
    expect(tables.meeting_bot_jobs![0]!.retry_count).toBe(0);
    expect(tables.operational_incidents).toHaveLength(0);
  });

  it("stale bot + provider confirms it's gone -> recovered through the normal path", async () => {
    const tables = emptyTables({
      meeting_bot_jobs: [
        {
          id: "b1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "joining",
          retry_count: 0,
          updated_at: stale,
          provider_bot_id: "bot-gone",
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const provider = new FakeMeetingBotProvider();
    provider.advanceTo("bot-gone", "completed");

    const results = await recoverStuckJobs(supabase, provider, ORG);

    const bot = results.find((r) => r.queue === "meeting_bot")!;
    expect(bot.recovered).toBe(1);
    expect(tables.meeting_bot_jobs![0]!.status).toBe("pending");
    expect(tables.meeting_bot_jobs![0]!.retry_count).toBe(1);
    expect(tables.operational_incidents![0]!.incident_type).toBe("stuck");
  });

  it("stale bot + provider lookup fails/unknown -> fails safe: NOT recovered, no requeue, an incident is recorded instead", async () => {
    const tables = emptyTables({
      meeting_bot_jobs: [
        {
          id: "b1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "joining",
          retry_count: 0,
          updated_at: stale,
          provider_bot_id: "bot-unknown-to-provider",
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    // FakeMeetingBotProvider.getBotStatus throws for any id it was never
    // told about via createBot/advanceTo — exactly the "provider check
    // itself failed" scenario.
    const provider = new FakeMeetingBotProvider();

    const results = await recoverStuckJobs(supabase, provider, ORG);

    const bot = results.find((r) => r.queue === "meeting_bot")!;
    expect(bot.recovered).toBe(0);
    expect(bot.terminated).toBe(0);
    expect(tables.meeting_bot_jobs![0]!.status).toBe("joining");
    expect(tables.meeting_bot_jobs![0]!.retry_count).toBe(0);
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.incident_type).toBe(
      "provider_check_failed",
    );
  });

  it("repeated sweeps after a failed provider check remain idempotent and never create a second requeue attempt", async () => {
    const tables = emptyTables({
      meeting_bot_jobs: [
        {
          id: "b1",
          organization_id: ORG,
          meeting_id: "m1",
          status: "joining",
          retry_count: 0,
          updated_at: stale,
          provider_bot_id: "bot-unknown-to-provider",
        },
      ],
    });
    const supabase = fakeSupabase(tables);
    const provider = new FakeMeetingBotProvider();

    await recoverStuckJobs(supabase, provider, ORG);
    await recoverStuckJobs(supabase, provider, ORG);
    await recoverStuckJobs(supabase, provider, ORG);

    // Same open incident bumped, never a duplicate row, and the job was
    // never requeued (no second join attempt created).
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.occurrence_count).toBe(3);
    expect(tables.meeting_bot_jobs![0]!.status).toBe("joining");
    expect(tables.meeting_bot_jobs![0]!.retry_count).toBe(0);
  });
});
