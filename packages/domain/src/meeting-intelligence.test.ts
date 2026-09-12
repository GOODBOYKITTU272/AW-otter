import { describe, expect, it } from "vitest";
import {
  FakeMeetingIntelligenceProvider,
  fakeResult,
  IntelligenceApiError,
  IntelligenceMalformedResponseError,
  IntelligenceTimeoutError,
} from "@applywizz/ai";
import {
  enqueuePendingIntelligenceRuns,
  materializeReadyCustomerTruthDeltas,
  processIntelligenceQueue,
  processIntelligenceRun,
  type AppSupabaseClient,
} from "./meeting-intelligence";

// --- Minimal stateful in-memory fake, same shape/reasoning as
// transcription.test.ts's own fake — a static per-call handler can't
// represent this module's real claim/complete/materialize orchestration.
interface Row {
  [key: string]: unknown;
}

class FakeTable {
  rows: Row[] = [];
  private nextId = 1;
  constructor(public idPrefix = "row") {}
  genId(): string {
    return `${this.idPrefix}-${this.nextId++}`;
  }
}

function matchesFilters(row: Row, filters: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith("is_")) {
      const col = key.slice(3);
      if (value === null ? row[col] !== null : row[col] !== value) return false;
    } else {
      if (row[key] !== value) return false;
    }
  }
  return true;
}

function createFakeSupabase(
  tables: Record<string, FakeTable>,
  options: { failMaterialize?: boolean; failIntegrity?: boolean } = {},
): AppSupabaseClient {
  function from(tableName: string) {
    if (options.failIntegrity && tableName === "meeting_integrity_reports") {
      throw new Error(
        "Simulated RPC or DB connection failure in integrity backstop",
      );
    }
    const table = tables[tableName];
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | Row[] | undefined;
    let orderCol: string | null = null;
    let requireLinkedMeeting = false;

    function currentRows(): Row[] {
      let rows = (table?.rows ?? []).filter((r) => matchesFilters(r, filters));
      if (requireLinkedMeeting && tableName === "ai_runs") {
        rows = rows.filter((r) => {
          const meeting = tables.meetings?.rows.find(
            (m) => m.id === r.meeting_id,
          );
          return meeting?.customer_id != null;
        });
      }
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = Number(a[orderCol as string] ?? 0);
          const bv = Number(b[orderCol as string] ?? 0);
          return av - bv;
        });
      }
      return rows;
    }

    function applyWrite(): { data: Row | Row[] | null; error: unknown } {
      if (!table) return { data: null, error: null };
      if (op === "insert") {
        const items = Array.isArray(payload) ? payload : [payload as Row];
        const created: Row[] = [];
        for (const item of items) {
          const newRow: Row = {
            id: table.genId(),
            retry_count: 0,
            customer_truth_materialized_at: null,
            ...item,
          };
          if (tableName === "ai_runs") {
            const dup = table.rows.some(
              (r) =>
                r.meeting_id === newRow.meeting_id &&
                r.transcript_id === newRow.transcript_id &&
                r.run_type === newRow.run_type &&
                r.model === newRow.model &&
                r.prompt_version === newRow.prompt_version &&
                r.provider_config_version === newRow.provider_config_version,
            );
            if (dup) return { data: null, error: { code: "23505" } };
          }
          table.rows.push(newRow);
          created.push(newRow);
        }
        return {
          data: Array.isArray(payload) ? created : (created[0] ?? null),
          error: null,
        };
      }
      // update
      const matched = currentRows();
      for (const row of matched) Object.assign(row, payload);
      return { data: matched[0] ?? null, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      is(column: string, value: unknown) {
        filters[`is_${column}`] = value;
        return builder;
      },
      not(column: string, _op: string, value: unknown) {
        if (column === "meetings.customer_id" && value === null) {
          requireLinkedMeeting = true;
        }
        return builder;
      },
      order(column: string) {
        orderCol = column;
        return builder;
      },
      async single() {
        if (op === "select") {
          const rows = currentRows();
          return {
            data: rows[0] ?? null,
            error: rows[0] ? null : { message: "not found" },
          };
        }
        return applyWrite();
      },
      async maybeSingle() {
        if (op === "select") {
          const rows = currentRows();
          return { data: rows[0] ?? null, error: null };
        }
        return applyWrite();
      },
      then(
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        const result =
          op === "select" ? { data: currentRows(), error: null } : applyWrite();
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  async function rpc(fnName: string, args?: Record<string, unknown>) {
    if (fnName === "claim_next_meeting_intelligence_run") {
      const runs = tables.ai_runs;
      if (!runs) return { data: null, error: null };
      const claimable = runs.rows.find(
        (r) => r.status === "pending" || r.status === "retryable",
      );
      if (!claimable) return { data: null, error: null };
      claimable.status = "running";
      return { data: claimable, error: null };
    }

    if (fnName === "complete_meeting_intelligence_run") {
      const runs = tables.ai_runs;
      const callRecords = tables.call_records;
      if (!runs) return { data: false, error: null };
      const run = runs.rows.find(
        (r) =>
          r.id === args?.p_run_id &&
          r.organization_id === args?.p_organization_id,
      );
      if (!run || run.status === "completed")
        return { data: false, error: null };

      Object.assign(run, {
        status: "completed",
        summary: args?.p_summary,
        validated_output: args?.p_validated_output,
        usage_metadata: args?.p_usage_metadata,
        completed_at: new Date().toISOString(),
      });
      const incoming = (args?.p_call_records as Row[] | undefined) ?? [];
      for (const rec of incoming) {
        callRecords?.rows.push({
          id: callRecords.genId(),
          organization_id: args?.p_organization_id,
          meeting_id: run.meeting_id,
          ai_run_id: run.id,
          status: "detected",
          ...rec,
        });
      }
      return { data: true, error: null };
    }

    if (fnName === "materialize_customer_truth_deltas") {
      if (options.failMaterialize) {
        return {
          data: null,
          error: { message: "simulated materialize failure" },
        };
      }
      const runs = tables.ai_runs;
      const meetings = tables.meetings;
      const facts = tables.customer_truth_facts;
      if (!runs) return { data: false, error: null };
      const run = runs.rows.find(
        (r) =>
          r.id === args?.p_run_id &&
          r.organization_id === args?.p_organization_id,
      );
      if (
        !run ||
        run.status !== "completed" ||
        run.customer_truth_materialized_at !== null
      ) {
        return { data: false, error: null };
      }
      const meeting = meetings?.rows.find((m) => m.id === run.meeting_id);
      if (!meeting?.customer_id) return { data: false, error: null };

      const output = run.validated_output as {
        customerTruthDeltas?: Row[];
      } | null;
      for (const delta of output?.customerTruthDeltas ?? []) {
        facts?.rows.push({
          id: facts.genId(),
          organization_id: args?.p_organization_id,
          customer_id: meeting.customer_id,
          field_key: delta.fieldKey,
          value: delta.proposedValue,
          status: "proposed",
          source_type: "meeting",
          source_meeting_id: run.meeting_id,
          evidence_segment_ids: delta.evidenceSegmentIds,
        });
      }
      run.customer_truth_materialized_at = new Date().toISOString();
      return { data: true, error: null };
    }

    if (fnName === "save_meeting_integrity_report_atomic") {
      const reports = tables.meeting_integrity_reports;
      const flags = tables.meeting_integrity_flags;
      if (!reports) return { data: null, error: null };

      const existing = reports.rows.find(
        (r) =>
          r.organization_id === args?.p_organization_id &&
          r.meeting_id === args?.p_meeting_id,
      );
      if (existing) {
        Object.assign(existing, {
          overall_verdict: args?.p_overall_verdict,
          summary: args?.p_summary,
          confidence_score_avg: args?.p_confidence_score_avg,
          suspected_background_media: args?.p_suspected_background_media,
          metrics: args?.p_metrics,
        });
      } else {
        reports.rows.push({
          id: reports.genId(),
          organization_id: args?.p_organization_id,
          meeting_id: args?.p_meeting_id,
          overall_verdict: args?.p_overall_verdict,
          summary: args?.p_summary,
          confidence_score_avg: args?.p_confidence_score_avg,
          suspected_background_media: args?.p_suspected_background_media,
          metrics: args?.p_metrics,
        });
      }

      const reportId = existing?.id ?? reports.rows[reports.rows.length - 1]?.id;

      if (flags && reportId) {
        flags.rows = flags.rows.filter((f) => f.report_id !== reportId);
        const incomingFlags = (args?.p_flags as Row[] | undefined) ?? [];
        for (const flag of incomingFlags) {
          flags.rows.push({
            id: flags.genId(),
            organization_id: args?.p_organization_id,
            report_id: reportId,
            meeting_id: args?.p_meeting_id,
            ...flag,
          });
        }
      }

      return { data: { id: reportId }, error: null };
    }

    return { data: null, error: { message: `unmocked rpc: ${fnName}` } };
  }

  return { from, rpc } as unknown as AppSupabaseClient;
}

function baseTables() {
  return {
    meetings: new FakeTable("meeting"),
    meeting_transcripts: new FakeTable("transcript"),
    transcript_segments: new FakeTable("segment"),
    ai_runs: new FakeTable("run"),
    call_records: new FakeTable("record"),
    customer_truth_facts: new FakeTable("fact"),
    meeting_lifecycle_events: new FakeTable("event"),
    meeting_integrity_reports: new FakeTable("integrity_report"),
    meeting_integrity_flags: new FakeTable("integrity_flag"),
  };
}

describe("enqueuePendingIntelligenceRuns", () => {
  it("enqueues one ai_runs row per completed transcript under the current identity", async () => {
    const tables = baseTables();
    tables.meeting_transcripts.rows.push({
      id: "t1",
      meeting_id: "m1",
      organization_id: "org1",
      processing_status: "completed",
    });
    tables.transcript_segments.rows.push({
      id: "seg1",
      transcript_id: "t1",
      sequence_index: 0,
      start_ms: 0,
      end_ms: 15000,
      original_text: "Test segment",
      canonical_english_text: "Test segment",
    });
    const supabase = createFakeSupabase(tables);

    const result = await enqueuePendingIntelligenceRuns(supabase, "org1");
    expect(result.enqueued).toBe(1);
    expect(tables.ai_runs.rows).toHaveLength(1);
    expect(tables.ai_runs.rows[0]?.status).toBe("pending");
  });

  it("is idempotent — re-running the scan does not create a duplicate under the same identity", async () => {
    const tables = baseTables();
    tables.meeting_transcripts.rows.push({
      id: "t1",
      meeting_id: "m1",
      organization_id: "org1",
      processing_status: "completed",
    });
    tables.transcript_segments.rows.push({
      id: "seg1",
      transcript_id: "t1",
      sequence_index: 0,
      start_ms: 0,
      end_ms: 15000,
      original_text: "Test",
      canonical_english_text: "Test",
    });
    const supabase = createFakeSupabase(tables);

    await enqueuePendingIntelligenceRuns(supabase, "org1");
    const second = await enqueuePendingIntelligenceRuns(supabase, "org1");
    expect(second.enqueued).toBe(0);
    expect(tables.ai_runs.rows).toHaveLength(1);
  });

  it("skips meetings where integrity evaluation fails (conservative: don't process without verification)", async () => {
    const tables = baseTables();
    tables.meeting_transcripts.rows.push({
      id: "t1",
      meeting_id: "m1",
      organization_id: "org1",
      processing_status: "completed",
    });
    const supabase = createFakeSupabase(tables, { failIntegrity: true });

    const result = await enqueuePendingIntelligenceRuns(supabase, "org1");
    // Phase 4: integrity evaluation failure now blocks (conservative approach)
    expect(result.enqueued).toBe(0);
    expect(tables.ai_runs.rows).toHaveLength(0);
  });
});

describe("processIntelligenceRun", () => {
  function setupRun(
    tables: ReturnType<typeof baseTables>,
    customerId: string | null,
  ) {
    tables.meetings.rows.push({
      id: "m1",
      organization_id: "org1",
      call_type: "discovery",
      customer_id: customerId,
    });
    tables.transcript_segments.rows.push({
      id: "seg1",
      transcript_id: "t1",
      sequence_index: 0,
      original_text: "raw",
      canonical_english_text: "clean text",
      speaker_label: "speaker_unknown",
    });
    // Phase 4: default PASS integrity so process tests exercise the happy path
    tables.meeting_integrity_reports.rows.push({
      id: "report1",
      organization_id: "org1",
      meeting_id: "m1",
      overall_verdict: "good",
      summary: "Clean transcript",
    });
    const run = {
      id: "run1",
      organization_id: "org1",
      meeting_id: "m1",
      transcript_id: "t1",
      status: "running",
      retry_count: 0,
      customer_truth_materialized_at: null,
    };
    tables.ai_runs.rows.push(run);
    return run;
  }

  it("uses canonical_english_text when available, calls the provider, and completes the run", async () => {
    const tables = baseTables();
    setupRun(tables, "cust1");
    const supabase = createFakeSupabase(tables);
    const provider = new FakeMeetingIntelligenceProvider({
      result: fakeResult({
        callRecords: [
          {
            recordType: "action_item",
            description: "Follow up",
            ownerType: "am",
            ownerRef: null,
            dueAt: null,
            evidenceSegmentIds: ["seg1"],
          },
        ],
      }),
      model: "openai/gpt-4o",
      usage: { promptTokens: 10, completionTokens: 5, cost: 0.001 },
      providerMetadata: {},
    });

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(provider.extractCalls[0]?.segments[0]?.text).toBe("clean text");
    expect(tables.ai_runs.rows[0]?.status).toBe("completed");
    expect(tables.call_records.rows).toHaveLength(1);
  });

  it("materializes customer_truth_facts immediately when the meeting is already linked", async () => {
    const tables = baseTables();
    setupRun(tables, "cust1");
    const supabase = createFakeSupabase(tables);
    const provider = new FakeMeetingIntelligenceProvider({
      result: fakeResult({
        customerTruthDeltas: [
          {
            fieldKey: "target_roles",
            previousValue: null,
            proposedValue: "Python backend",
            confidence: 0.9,
            evidenceSegmentIds: ["seg1"],
          },
        ],
      }),
      model: "openai/gpt-4o",
      usage: { promptTokens: 1, completionTokens: 1, cost: null },
      providerMetadata: {},
    });

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(tables.customer_truth_facts.rows).toHaveLength(1);
    expect(tables.customer_truth_facts.rows[0]?.status).toBe("proposed");
    expect(
      tables.ai_runs.rows[0]?.customer_truth_materialized_at,
    ).not.toBeNull();
  });

  it("does NOT discard customer_truth_deltas when the meeting is unlinked (M9 correction #1) — completes, but does not materialize", async () => {
    const tables = baseTables();
    setupRun(tables, null);
    const supabase = createFakeSupabase(tables);
    const provider = new FakeMeetingIntelligenceProvider({
      result: fakeResult({
        customerTruthDeltas: [
          {
            fieldKey: "target_roles",
            previousValue: null,
            proposedValue: "Python backend",
            confidence: 0.9,
            evidenceSegmentIds: ["seg1"],
          },
        ],
      }),
      model: "openai/gpt-4o",
      usage: { promptTokens: 1, completionTokens: 1, cost: null },
      providerMetadata: {},
    });

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(tables.ai_runs.rows[0]?.status).toBe("completed");
    expect(tables.ai_runs.rows[0]?.validated_output).toBeTruthy();
    expect(tables.customer_truth_facts.rows).toHaveLength(0);
    expect(tables.ai_runs.rows[0]?.customer_truth_materialized_at).toBeNull();
  });

  it("classifies a timeout and schedules a retry rather than failing terminally", async () => {
    const tables = baseTables();
    setupRun(tables, null);
    const supabase = createFakeSupabase(tables);
    const provider = {
      name: "fake",
      extract: async () => {
        throw new IntelligenceTimeoutError();
      },
    };

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(tables.ai_runs.rows[0]?.status).toBe("retryable");
    expect(tables.ai_runs.rows[0]?.error_code).toBe("intelligence_timeout");
    expect(tables.ai_runs.rows[0]?.retry_count).toBe(1);
  });

  it("marks the run terminally failed once retry_count reaches the max", async () => {
    const tables = baseTables();
    const run = setupRun(tables, null);
    run.retry_count = 4;
    const supabase = createFakeSupabase(tables);
    const provider = {
      name: "fake",
      extract: async () => {
        throw new IntelligenceMalformedResponseError("bad json");
      },
    };

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(tables.ai_runs.rows[0]?.status).toBe("failed");
    expect(tables.ai_runs.rows[0]?.error_code).toBe(
      "intelligence_malformed_response",
    );
    expect(tables.ai_runs.rows[0]?.next_retry_at).toBeNull();
  });

  it("classifies a provider API error distinctly from a malformed response", async () => {
    const tables = baseTables();
    setupRun(tables, null);
    const supabase = createFakeSupabase(tables);
    const provider = {
      name: "fake",
      extract: async () => {
        throw new IntelligenceApiError(500, "boom");
      },
    };

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    expect(tables.ai_runs.rows[0]?.error_code).toBe("intelligence_failed");
  });

  it("does NOT revert an already-completed run when post-completion follow-up work fails (Codex review BLOCKING, fixed)", async () => {
    const tables = baseTables();
    setupRun(tables, "cust1");
    const supabase = createFakeSupabase(tables, { failMaterialize: true });
    const provider = new FakeMeetingIntelligenceProvider({
      result: fakeResult({
        callRecords: [
          {
            recordType: "action_item",
            description: "Follow up",
            ownerType: "am",
            ownerRef: null,
            dueAt: null,
            evidenceSegmentIds: ["seg1"],
          },
        ],
      }),
      model: "openai/gpt-4o",
      usage: { promptTokens: 1, completionTokens: 1, cost: null },
      providerMetadata: {},
    });

    await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
      provider,
    });

    // Extraction/persistence succeeded before the injected materialize
    // failure — the run must stay 'completed' with its real evidence,
    // never reverted to 'retryable'/'failed' (which would let a reclaim
    // call the AI provider again and double-insert call_records).
    expect(tables.ai_runs.rows[0]?.status).toBe("completed");
    expect(tables.ai_runs.rows[0]?.retry_count).toBe(0);
    expect(tables.ai_runs.rows[0]?.error_code).toBeUndefined();
    expect(tables.call_records.rows).toHaveLength(1);
  });
});

describe("processIntelligenceQueue", () => {
  it("drains claimable runs one at a time via claim_next_meeting_intelligence_run", async () => {
    const tables = baseTables();
    tables.meetings.rows.push({
      id: "m1",
      organization_id: "org1",
      call_type: "discovery",
      customer_id: null,
    });
    tables.meetings.rows.push({
      id: "m2",
      organization_id: "org1",
      call_type: null,
      customer_id: null,
    });
    tables.transcript_segments.rows.push({
      id: "seg1",
      transcript_id: "t1",
      sequence_index: 0,
      original_text: "x",
      canonical_english_text: "x",
      speaker_label: "speaker_unknown",
    });
    tables.transcript_segments.rows.push({
      id: "seg2",
      transcript_id: "t2",
      sequence_index: 0,
      original_text: "y",
      canonical_english_text: "y",
      speaker_label: "speaker_unknown",
    });
    tables.ai_runs.rows.push({
      id: "run1",
      organization_id: "org1",
      meeting_id: "m1",
      transcript_id: "t1",
      status: "pending",
      retry_count: 0,
    });
    tables.ai_runs.rows.push({
      id: "run2",
      organization_id: "org1",
      meeting_id: "m2",
      transcript_id: "t2",
      status: "pending",
      retry_count: 0,
    });
    tables.meeting_integrity_reports.rows.push({
      id: "report1",
      organization_id: "org1",
      meeting_id: "m1",
      overall_verdict: "good",
      summary: "Clean",
    });
    tables.meeting_integrity_reports.rows.push({
      id: "report2",
      organization_id: "org1",
      meeting_id: "m2",
      overall_verdict: "good",
      summary: "Clean",
    });
    const supabase = createFakeSupabase(tables);
    const provider = new FakeMeetingIntelligenceProvider({
      result: fakeResult(),
      model: "openai/gpt-4o",
      usage: { promptTokens: null, completionTokens: null, cost: null },
      providerMetadata: {},
    });

    const result = await processIntelligenceQueue(supabase, { provider }, 5);
    expect(result.claimed).toBe(2);
    expect(result.completed).toBe(2);
    expect(result.failedOrRetrying).toBe(0);
  });
});

describe("materializeReadyCustomerTruthDeltas", () => {
  it("sweeps completed-but-unmaterialized runs and materializes the ones whose meeting is now linked", async () => {
    const tables = baseTables();
    tables.meetings.rows.push({
      id: "m1",
      organization_id: "org1",
      customer_id: "cust1",
    });
    tables.meetings.rows.push({
      id: "m2",
      organization_id: "org1",
      customer_id: null,
    });
    tables.ai_runs.rows.push({
      id: "run1",
      organization_id: "org1",
      meeting_id: "m1",
      status: "completed",
      customer_truth_materialized_at: null,
      validated_output: {
        customerTruthDeltas: [
          {
            fieldKey: "target_roles",
            proposedValue: "x",
            evidenceSegmentIds: ["seg1"],
          },
        ],
      },
    });
    tables.ai_runs.rows.push({
      id: "run2",
      organization_id: "org1",
      meeting_id: "m2",
      status: "completed",
      customer_truth_materialized_at: null,
      validated_output: {
        customerTruthDeltas: [
          {
            fieldKey: "target_roles",
            proposedValue: "y",
            evidenceSegmentIds: ["seg2"],
          },
        ],
      },
    });
    const supabase = createFakeSupabase(tables);

    const result = await materializeReadyCustomerTruthDeltas(supabase, "org1");

    expect(result.materialized).toBe(1);
    expect(tables.customer_truth_facts.rows).toHaveLength(1);
    expect(
      tables.ai_runs.rows.find((r) => r.id === "run1")
        ?.customer_truth_materialized_at,
    ).not.toBeNull();
    expect(
      tables.ai_runs.rows.find((r) => r.id === "run2")
        ?.customer_truth_materialized_at,
    ).toBeNull();
  });
});

describe("Phase 4: Integrity Gate Enforcement — Hard Block for FAIL Verdicts", () => {
  describe("enqueuePendingIntelligenceRuns: FAIL blocks enqueue", () => {
    it("does NOT enqueue intelligence when integrity verdict is transcription_unreliable", async () => {
      const tables = baseTables();
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "Test",
        canonical_english_text: "Test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "transcription_unreliable",
        summary: "Critical hallucination loops detected",
      });
      const supabase = createFakeSupabase(tables);

      const result = await enqueuePendingIntelligenceRuns(supabase, "org1");

      expect(result.enqueued).toBe(0);
      expect(tables.ai_runs.rows).toHaveLength(0);
      expect(
        tables.meeting_lifecycle_events.rows.some(
          (e) => e.event_type === "meeting_intelligence.blocked_by_integrity",
        ),
      ).toBe(true);
    });

    it("does NOT enqueue intelligence when integrity verdict is insufficient_speech", async () => {
      const tables = baseTables();
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "Test",
        canonical_english_text: "Test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "insufficient_speech",
        summary: "Less than 10 seconds of transcribed speech",
      });
      const supabase = createFakeSupabase(tables);

      const result = await enqueuePendingIntelligenceRuns(supabase, "org1");

      expect(result.enqueued).toBe(0);
      expect(tables.ai_runs.rows).toHaveLength(0);
    });

    it("DOES enqueue intelligence when integrity verdict is needs_review (WARN policy)", async () => {
      const tables = baseTables();
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "Test",
        canonical_english_text: "Test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "needs_review",
        summary: "Transcript repetition warnings detected",
      });
      const supabase = createFakeSupabase(tables);

      const result = await enqueuePendingIntelligenceRuns(supabase, "org1");

      expect(result.enqueued).toBe(1);
      expect(tables.ai_runs.rows).toHaveLength(1);
      expect(tables.meeting_integrity_reports.rows[0]?.overall_verdict).toBe(
        "needs_review",
      );
    });

    it("DOES enqueue intelligence when integrity verdict is good (PASS)", async () => {
      const tables = baseTables();
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "Test",
        canonical_english_text: "Test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "good",
        summary: "Clean transcript",
      });
      const supabase = createFakeSupabase(tables);

      const result = await enqueuePendingIntelligenceRuns(supabase, "org1");

      expect(result.enqueued).toBe(1);
      expect(tables.ai_runs.rows).toHaveLength(1);
    });
  });

  describe("processIntelligenceRun: FAIL blocks processing (defense in depth)", () => {
    it("refuses to process ai_run when integrity verdict is transcription_unreliable", async () => {
      const tables = baseTables();
      tables.meetings.rows.push({
        id: "m1",
        organization_id: "org1",
        call_type: "discovery",
        customer_id: "cust1",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "transcription_unreliable",
        summary: "Critical hallucination loops",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        original_text: "test",
        canonical_english_text: "test",
      });
      const run = {
        id: "run1",
        organization_id: "org1",
        meeting_id: "m1",
        transcript_id: "t1",
        status: "running",
        retry_count: 0,
        customer_truth_materialized_at: null,
      };
      tables.ai_runs.rows.push(run);
      const supabase = createFakeSupabase(tables);
      const provider = new FakeMeetingIntelligenceProvider({
        result: fakeResult({}),
        model: "test",
        usage: { promptTokens: 1, completionTokens: 1, cost: null },
        providerMetadata: {},
      });

      await processIntelligenceRun(supabase, run as never, { provider });

      const updatedRun = tables.ai_runs.rows[0];
      expect(updatedRun?.status).not.toBe("completed");
      expect(updatedRun?.status).toMatch(/failed|retryable/);
      expect(provider.extractCalls).toHaveLength(0);
      expect(tables.call_records.rows).toHaveLength(0);
    });

    it("refuses to process ai_run when integrity verdict is insufficient_speech", async () => {
      const tables = baseTables();
      tables.meetings.rows.push({
        id: "m1",
        organization_id: "org1",
        call_type: "discovery",
        customer_id: "cust1",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "insufficient_speech",
        summary: "Less than 10s of speech",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        original_text: "test",
        canonical_english_text: "test",
      });
      const run = {
        id: "run1",
        organization_id: "org1",
        meeting_id: "m1",
        transcript_id: "t1",
        status: "running",
        retry_count: 0,
        customer_truth_materialized_at: null,
      };
      tables.ai_runs.rows.push(run);
      const supabase = createFakeSupabase(tables);
      const provider = new FakeMeetingIntelligenceProvider({
        result: fakeResult({}),
        model: "test",
        usage: { promptTokens: 1, completionTokens: 1, cost: null },
        providerMetadata: {},
      });

      await processIntelligenceRun(supabase, run as never, { provider });

      expect(tables.ai_runs.rows[0]?.status).not.toBe("completed");
      expect(provider.extractCalls).toHaveLength(0);
    });
  });

  describe("Gate checklist proofs", () => {
    it("INTEGRITY FAIL BLOCKS AI + CUSTOMER TRUTH; FAILED EVIDENCE PRESERVED; PASS CAN CONTINUE", async () => {
      const tables = baseTables();
      tables.meetings.rows.push({
        id: "m1",
        organization_id: "org1",
        call_type: "discovery",
        customer_id: "cust1",
      });
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "test",
        canonical_english_text: "test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "transcription_unreliable",
        summary: "Critical",
      });
      const supabase = createFakeSupabase(tables);

      const enqueueResult = await enqueuePendingIntelligenceRuns(supabase, "org1");
      expect(enqueueResult.enqueued).toBe(0);
      expect(tables.ai_runs.rows).toHaveLength(0);
      expect(tables.customer_truth_facts.rows).toHaveLength(0);
      // FAILED EVIDENCE PRESERVED
      expect(tables.meeting_integrity_reports.rows).toHaveLength(1);
      expect(tables.meeting_integrity_reports.rows[0]?.overall_verdict).toBe(
        "transcription_unreliable",
      );
    });

    it("PASS CAN CONTINUE through enqueue and process", async () => {
      const tables = baseTables();
      tables.meetings.rows.push({
        id: "m1",
        organization_id: "org1",
        call_type: "discovery",
        customer_id: "cust1",
      });
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "test",
        canonical_english_text: "test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "good",
        summary: "Clean",
      });
      const supabase = createFakeSupabase(tables);

      const enqueueResult = await enqueuePendingIntelligenceRuns(supabase, "org1");
      const provider = new FakeMeetingIntelligenceProvider({
        result: fakeResult({
          callRecords: [
            {
              recordType: "action_item",
              description: "Follow up",
              ownerType: "am",
              ownerRef: null,
              dueAt: null,
              evidenceSegmentIds: ["seg1"],
            },
          ],
          customerTruthDeltas: [
            {
              fieldKey: "target_roles",
              previousValue: null,
              proposedValue: "Python",
              confidence: 0.9,
              evidenceSegmentIds: ["seg1"],
            },
          ],
        }),
        model: "test",
        usage: { promptTokens: 1, completionTokens: 1, cost: null },
        providerMetadata: {},
      });

      expect(enqueueResult.enqueued).toBe(1);
      await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
        provider,
      });

      expect(tables.ai_runs.rows[0]?.status).toBe("completed");
      expect(tables.call_records.rows).toHaveLength(1);
      expect(tables.customer_truth_facts.rows).toHaveLength(1);
    });

    it("WARN POLICY EXPLICIT: needs_review allows processing but remains auditable", async () => {
      const tables = baseTables();
      tables.meetings.rows.push({
        id: "m1",
        organization_id: "org1",
        call_type: "discovery",
        customer_id: "cust1",
      });
      tables.meeting_transcripts.rows.push({
        id: "t1",
        meeting_id: "m1",
        organization_id: "org1",
        processing_status: "completed",
      });
      tables.transcript_segments.rows.push({
        id: "seg1",
        transcript_id: "t1",
        sequence_index: 0,
        start_ms: 0,
        end_ms: 15000,
        original_text: "test",
        canonical_english_text: "test",
      });
      tables.meeting_integrity_reports.rows.push({
        id: "report1",
        organization_id: "org1",
        meeting_id: "m1",
        overall_verdict: "needs_review",
        summary: "Repetition warnings",
      });
      const supabase = createFakeSupabase(tables);

      const enqueueResult = await enqueuePendingIntelligenceRuns(supabase, "org1");
      const provider = new FakeMeetingIntelligenceProvider({
        result: fakeResult({}),
        model: "test",
        usage: { promptTokens: 1, completionTokens: 1, cost: null },
        providerMetadata: {},
      });

      expect(enqueueResult.enqueued).toBe(1);
      await processIntelligenceRun(supabase, tables.ai_runs.rows[0] as never, {
        provider,
      });

      expect(tables.ai_runs.rows[0]?.status).toBe("completed");
      expect(tables.meeting_integrity_reports.rows[0]?.overall_verdict).toBe(
        "needs_review",
      );
    });
  });
});
