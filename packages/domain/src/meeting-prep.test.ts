import { describe, expect, it } from "vitest";
import { getMeetingPrepData, type AppSupabaseClient } from "./meeting-prep";

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
      lt(col: string, value: unknown) {
        filtered = filtered.filter((r) => String(r[col]) < String(value));
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
      if (limitN) result = result.slice(0, limitN);
      return result;
    }

    return builder;
  }
  return { from } as unknown as AppSupabaseClient;
}

const BASE_MEETING = {
  id: "meeting-current",
  organization_id: "org-1",
  customer_id: "cust-1",
  call_type: "resume_review",
  scheduled_start: "2026-09-10T00:00:00Z",
};
const BASE_CUSTOMER = {
  id: "cust-1",
  name: "Test Customer",
  lifecycle_stage: "Progress",
};

describe("getMeetingPrepData", () => {
  it("returns null when the meeting isn't visible (RLS)", async () => {
    const supabase = fakeSupabase({ meetings: [] });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result).toBeNull();
  });

  it("reports previousMeeting: {status:'none'} for a customer's first tracked call — not an error state", async () => {
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING],
      customers: [BASE_CUSTOMER],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result?.previousMeeting).toEqual({ status: "none" });
    expect(result?.recommendedFocus).toEqual([]);
  });

  it("finds the previous meeting via the canonical `meetings` table, NOT scheduler_calls (Codex Pass 1 SHOULD-FIX regression)", async () => {
    // Deliberately no scheduler_calls rows at all — proves the lookup
    // doesn't depend on scheduler_calls being matched/present.
    const previousMeeting = {
      id: "meeting-previous",
      call_type: "discovery",
      scheduled_start: "2026-09-01T00:00:00Z",
      customer_id: "cust-1",
    };
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING, previousMeeting],
      customers: [BASE_CUSTOMER],
      meeting_transcripts: [
        {
          id: "t1",
          meeting_id: "meeting-previous",
          processing_status: "completed",
        },
      ],
      ai_runs: [
        {
          meeting_id: "meeting-previous",
          status: "completed",
          summary: "Previous call summary.",
          completed_at: "2026-09-01T01:00:00Z",
          validated_output: {
            summary: "Previous call summary.",
            callRecords: [],
            customerTruthDeltas: [],
            callTypeSpecific: null,
          },
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      transcript_segments: [],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result?.previousMeeting.status).toBe("ready");
    if (result?.previousMeeting.status === "ready") {
      expect(result.previousMeeting.summary).toBe("Previous call summary.");
    }
  });

  it("reports previousMeeting: {status:'not_ready'} when a prior meeting exists but its transcript isn't completed", async () => {
    const previousMeeting = {
      id: "meeting-previous",
      call_type: "discovery",
      scheduled_start: "2026-09-01T00:00:00Z",
      customer_id: "cust-1",
    };
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING, previousMeeting],
      customers: [BASE_CUSTOMER],
      meeting_transcripts: [
        {
          id: "t1",
          meeting_id: "meeting-previous",
          processing_status: "processing",
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result?.previousMeeting).toEqual({ status: "not_ready" });
  });

  it("recommendedFocus never mentions churn/risk-signal content, even when the previous meeting's callTypeSpecific has churnRiskEvidence (Codex Pass 1 SHOULD-FIX regression)", async () => {
    const previousMeeting = {
      id: "meeting-previous",
      call_type: "renewal",
      scheduled_start: "2026-09-01T00:00:00Z",
      customer_id: "cust-1",
    };
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING, previousMeeting],
      customers: [BASE_CUSTOMER],
      meeting_transcripts: [
        {
          id: "t1",
          meeting_id: "meeting-previous",
          processing_status: "completed",
        },
      ],
      ai_runs: [
        {
          meeting_id: "meeting-previous",
          status: "completed",
          summary: "Renewal call summary.",
          completed_at: "2026-09-01T01:00:00Z",
          validated_output: {
            summary: "Renewal call summary.",
            callRecords: [],
            customerTruthDeltas: [],
            callTypeSpecific: {
              callType: "renewal",
              valueDelivered: [],
              unresolvedProblems: [],
              objections: [
                { text: "SECRET_OBJECTION_TEXT", evidenceSegmentIds: [] },
              ],
              churnRiskEvidence: [
                { text: "SECRET_CHURN_RISK_TEXT", evidenceSegmentIds: [] },
              ],
              renewalDecision: "undecided",
              nextMonthStrategy: [
                { text: "Narrow to healthcare roles.", evidenceSegmentIds: [] },
              ],
            },
          },
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      transcript_segments: [],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    const serialized = JSON.stringify(result?.recommendedFocus);
    expect(serialized).not.toContain("SECRET_OBJECTION_TEXT");
    expect(serialized).not.toContain("SECRET_CHURN_RISK_TEXT");
  });

  it("openItems reflects whatever the caller's own RLS returns for the customer (never a service-role read)", async () => {
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING],
      customers: [BASE_CUSTOMER],
      call_records: [
        {
          id: "cr1",
          customer_id: "cust-1",
          record_type: "action_item",
          description: "Open item",
          status: "detected",
          due_at: null,
          evidence_segment_ids: [],
        },
        {
          id: "cr2",
          customer_id: "cust-1",
          record_type: "action_item",
          description: "Resolved item",
          status: "completed",
          due_at: null,
          evidence_segment_ids: [],
        },
      ],
      customer_truth_facts: [],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result?.openItems).toHaveLength(1);
    expect(result?.openItems[0]?.description).toBe("Open item");
  });

  it("pendingTruth reflects only status='proposed' facts for the customer", async () => {
    const supabase = fakeSupabase({
      meetings: [BASE_MEETING],
      customers: [BASE_CUSTOMER],
      call_records: [],
      customer_truth_facts: [
        {
          id: "f1",
          customer_id: "cust-1",
          field_key: "target_roles",
          value: ["X"],
          status: "proposed",
        },
        {
          id: "f2",
          customer_id: "cust-1",
          field_key: "work_mode",
          value: "remote",
          status: "confirmed",
        },
      ],
      customer_context_snapshots: [],
      scheduler_calls: [],
    });
    const result = await getMeetingPrepData(supabase, "meeting-current");
    expect(result?.pendingTruth).toHaveLength(1);
    expect(result?.pendingTruth[0]?.fieldKey).toBe("target_roles");
  });
});
