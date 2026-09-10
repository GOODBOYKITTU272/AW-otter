import { describe, expect, it } from "vitest";
import {
  deriveCustomerSafeRecap,
  getJourneyContext,
  getMeetingRecapData,
  listRecentMeetingSummaries,
  saveMeetingRecapDraft,
  approveMeetingRecap,
  type AppSupabaseClient,
} from "./meeting-recap";

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
    let countOnly = false;

    const builder = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) countOnly = Boolean(opts.head);
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
      lt(col: string, value: unknown) {
        filtered = filtered.filter((r) => String(r[col]) < String(value));
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
      async single() {
        const result = apply();
        return { data: result[0] ?? null, error: null };
      },
      async maybeSingle() {
        const result = apply();
        return { data: result[0] ?? null, error: null };
      },
      insert(row: Row) {
        const id = (row.id as string) ?? `gen-${Date.now()}`;
        const newRow = { id, ...row };
        tables[table] = tables[table] ?? [];
        tables[table].push(newRow);
        return {
          select() {
            return {
              single: async () => ({ data: newRow, error: null }),
            };
          },
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve({ data: newRow, error: null }).then(resolve);
          },
        };
      },
      upsert(row: Row) {
        tables[table] = tables[table] ?? [];
        const idx = tables[table].findIndex(
          (r) => r.meeting_id === row.meeting_id,
        );
        const existingId = idx >= 0 ? (tables[table][idx]?.id as string) : undefined;
        const id = (row.id as string) ?? existingId ?? `recap-${Date.now()}`;
        const newRow = { id, ...row };
        if (idx >= 0) {
          tables[table][idx] = { ...tables[table][idx], ...newRow };
        } else {
          tables[table].push(newRow);
        }
        return {
          select() {
            return {
              single: async () => ({
                data: (idx >= 0 ? tables[table]?.[idx] : newRow) ?? newRow,
                error: null,
              }),
            };
          },
        };
      },
      update(row: Row) {
        tables[table] = tables[table] ?? [];
        const updatedRows: Row[] = [];
        const updateBuilder = {
          eq(col: string, val: unknown) {
            for (let i = 0; i < tables[table]!.length; i++) {
              if (tables[table]![i]![col] === val) {
                tables[table]![i] = { ...tables[table]![i], ...row };
                updatedRows.push(tables[table]![i]!);
              }
            }
            return updateBuilder;
          },
          select() {
            return {
              single: async () => ({
                data: updatedRows[0] ?? null,
                error: null,
              }),
            };
          },
          then(resolve: (v: unknown) => unknown) {
            return Promise.resolve({ data: updatedRows, error: null }).then(resolve);
          },
        };
        return updateBuilder;
      },
      then(
        onFulfilled: (v: {
          data: unknown;
          error: unknown;
          count?: number;
        }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        const result = apply();
        const payload = countOnly
          ? { data: null, error: null, count: result.length }
          : { data: result, error: null };
        return Promise.resolve(payload).then(onFulfilled, onRejected);
      },
    };

    function apply() {
      let result = filtered;
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (typeof av === "number" && typeof bv === "number") {
            return ascending ? av - bv : bv - av;
          }
          const as = String(av ?? "");
          const bs = String(bv ?? "");
          return ascending ? as.localeCompare(bs) : bs.localeCompare(as);
        });
      }
      if (limitN) result = result.slice(0, limitN);
      return result;
    }

    return builder;
  }
  return { from } as unknown as AppSupabaseClient;
}

describe("deriveCustomerSafeRecap", () => {
  const baseInput = {
    customerName: "Anika Rao",
    callType: "discovery",
    meetingDate: "2026-09-03T15:30:00.000Z",
    nextJourneyStep: "Next: Resume Review scheduled Sep 10.",
  };

  it("splits commitments/action_items by owner and excludes internal-only record types", () => {
    const result = deriveCustomerSafeRecap({
      ...baseInput,
      callRecords: [
        {
          recordType: "commitment",
          description: "We agreed on X.",
          ownerType: "customer",
        },
        {
          recordType: "action_item",
          description: "ApplyWizz sends draft.",
          ownerType: "applywizz",
        },
        {
          recordType: "action_item",
          description: "Customer sends resume.",
          ownerType: "customer",
        },
        {
          recordType: "blocker",
          description: "Internal blocker text.",
          ownerType: "customer",
        },
        {
          recordType: "question",
          description: "Internal open question.",
          ownerType: "am",
        },
        {
          recordType: "decision",
          description: "Internal decision note.",
          ownerType: "am",
        },
      ],
    });

    expect(result.whatWeAgreed).toEqual(["We agreed on X."]);
    expect(result.applyWizzWillDo).toEqual(["ApplyWizz sends draft."]);
    expect(result.customerShouldDo).toEqual(["Customer sends resume."]);
    // Never reads blocker/question/decision — no trace of their text anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Internal blocker");
    expect(serialized).not.toContain("Internal open question");
    expect(serialized).not.toContain("Internal decision");
  });

  it("carries the journey step through as the next step verbatim", () => {
    const result = deriveCustomerSafeRecap({ ...baseInput, callRecords: [] });
    expect(result.nextStep).toBe("Next: Resume Review scheduled Sep 10.");
  });

  it("produces a generic greeting when call type is unknown", () => {
    const result = deriveCustomerSafeRecap({
      ...baseInput,
      callType: null,
      callRecords: [],
    });
    expect(result.greeting).toContain("Thanks for the call on");
    expect(result.greeting).not.toContain("null");
  });
});

describe("getJourneyContext", () => {
  it("finds the previous completed call and the next scheduled call around the current meeting", async () => {
    const supabase = fakeSupabase({
      scheduler_calls: [
        {
          canonical_call_type: "discovery",
          scheduled_at: "2026-08-01T00:00:00Z",
          meeting_id: "meeting-past",
          external_status: "COMPLETED",
          customer_id: "cust-1",
        },
        {
          canonical_call_type: "resume_review",
          scheduled_at: "2026-09-01T00:00:00Z",
          meeting_id: "meeting-current",
          external_status: "COMPLETED",
          customer_id: "cust-1",
        },
        {
          canonical_call_type: "orientation",
          scheduled_at: "2099-01-01T00:00:00Z",
          meeting_id: null,
          external_status: "SCHEDULED",
          customer_id: "cust-1",
        },
      ],
    });

    const journey = await getJourneyContext(
      supabase,
      "cust-1",
      "meeting-current",
    );
    expect(journey.previousCall?.callType).toBe("discovery");
    expect(journey.nextCall?.callType).toBe("orientation");
  });

  it("returns nulls when there is no previous or next call", async () => {
    const supabase = fakeSupabase({
      scheduler_calls: [
        {
          canonical_call_type: "discovery",
          scheduled_at: "2026-08-01T00:00:00Z",
          meeting_id: "meeting-current",
          external_status: "COMPLETED",
          customer_id: "cust-1",
        },
      ],
    });

    const journey = await getJourneyContext(
      supabase,
      "cust-1",
      "meeting-current",
    );
    expect(journey.previousCall).toBeNull();
    expect(journey.nextCall).toBeNull();
  });

  it("never returns a cancelled/rescheduled row as the next call", async () => {
    const supabase = fakeSupabase({
      scheduler_calls: [
        {
          canonical_call_type: "discovery",
          scheduled_at: "2026-08-01T00:00:00Z",
          meeting_id: "meeting-current",
          external_status: "COMPLETED",
          customer_id: "cust-1",
        },
        {
          canonical_call_type: "progress",
          scheduled_at: "2099-01-01T00:00:00Z",
          meeting_id: null,
          external_status: "RESCHEDULED",
          customer_id: "cust-1",
        },
      ],
    });

    const journey = await getJourneyContext(
      supabase,
      "cust-1",
      "meeting-current",
    );
    expect(journey.nextCall).toBeNull();
  });

  it("never picks an already-matched FUTURE call as 'previous' when the current meeting isn't itself in scheduler_calls (Codex Pass 2 regression)", async () => {
    const supabase = fakeSupabase({
      scheduler_calls: [
        {
          canonical_call_type: "discovery",
          scheduled_at: "2026-08-01T00:00:00Z",
          meeting_id: "meeting-past",
          external_status: "COMPLETED",
          customer_id: "cust-1",
        },
        {
          canonical_call_type: "progress",
          scheduled_at: "2099-01-01T00:00:00Z",
          meeting_id: "meeting-future-already-matched",
          external_status: "SCHEDULED",
          customer_id: "cust-1",
        },
      ],
    });

    // "meeting-current-unlinked" deliberately does not appear in
    // scheduler_calls at all (e.g. manually linked, matcher hasn't run).
    const journey = await getJourneyContext(
      supabase,
      "cust-1",
      "meeting-current-unlinked",
    );
    expect(journey.previousCall?.callType).toBe("discovery");
  });
});

describe("listRecentMeetingSummaries", () => {
  it("only includes meetings with a completed ai_run, and counts records/truth facts per meeting", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "m1",
          customer_id: "cust-1",
          call_type: "discovery",
          scheduled_start: "2026-09-01T00:00:00Z",
        },
        {
          id: "m2",
          customer_id: "cust-1",
          call_type: "progress",
          scheduled_start: "2026-09-05T00:00:00Z",
        },
      ],
      ai_runs: [
        {
          meeting_id: "m1",
          summary: "Summary one.",
          status: "completed",
          completed_at: "2026-09-01T01:00:00Z",
        },
        {
          meeting_id: "m2",
          summary: null,
          status: "failed",
          completed_at: null,
        },
      ],
      call_records: [
        { meeting_id: "m1", status: "detected" },
        { meeting_id: "m1", status: "detected" },
        // Already resolved — must NOT count toward openActionCount
        // (Codex Pass 2 regression: the old query counted every status).
        { meeting_id: "m1", status: "completed" },
      ],
      customer_truth_facts: [{ source_meeting_id: "m1" }],
      customers: [{ id: "cust-1", name: "Anika Rao" }],
    });

    const result = await listRecentMeetingSummaries(supabase, {
      customerId: "cust-1",
    });

    expect(result).toHaveLength(1);
    const [summary] = result;
    expect(summary?.meetingId).toBe("m1");
    expect(summary?.customerName).toBe("Anika Rao");
    expect(summary?.openActionCount).toBe(2);
    expect(summary?.truthChangeCount).toBe(1);
  });

  it("orders and truncates by the meeting's own scheduled_start, never by ai_runs.completed_at (Codex Pass 3 regression)", async () => {
    // m-old was held long ago but got reprocessed recently (recent
    // completed_at). m-new was held much more recently but was processed
    // right away (older completed_at). With limit=1, the correct answer is
    // m-new (the actually more recent conversation) — a completed_at-desc
    // selection would have wrongly returned m-old instead.
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "m-old",
          customer_id: "cust-1",
          call_type: "discovery",
          scheduled_start: "2026-01-01T00:00:00Z",
        },
        {
          id: "m-new",
          customer_id: "cust-1",
          call_type: "progress",
          scheduled_start: "2026-09-01T00:00:00Z",
        },
      ],
      ai_runs: [
        {
          meeting_id: "m-old",
          summary: "Old meeting, reprocessed recently.",
          status: "completed",
          completed_at: "2026-09-08T00:00:00Z",
        },
        {
          meeting_id: "m-new",
          summary: "New meeting, processed right away.",
          status: "completed",
          completed_at: "2026-09-01T01:00:00Z",
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      customers: [{ id: "cust-1", name: "Anika Rao" }],
    });

    const result = await listRecentMeetingSummaries(supabase, {
      customerId: "cust-1",
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.meetingId).toBe("m-new");
  });

  it("returns an empty list when no meeting has a completed run", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "m1",
          customer_id: "cust-1",
          call_type: "discovery",
          scheduled_start: "2026-09-01T00:00:00Z",
        },
      ],
      ai_runs: [
        {
          meeting_id: "m1",
          summary: null,
          status: "pending",
          completed_at: null,
        },
      ],
      call_records: [],
      customer_truth_facts: [],
      customers: [],
    });

    const result = await listRecentMeetingSummaries(supabase, {
      customerId: "cust-1",
    });
    expect(result).toEqual([]);
  });
});

describe("getMeetingRecapData", () => {
  it("prefers a completed ai_run over a newer failed reprocess run (Codex Pass 2 regression)", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "meeting-1",
          organization_id: "org-1",
          title: "Discovery call",
          customer_id: null,
          call_type: "discovery",
          scheduled_start: "2026-09-01T00:00:00Z",
          actual_start: "2026-09-01T00:00:00Z",
          owner_membership_id: null,
        },
      ],
      meeting_transcripts: [
        {
          id: "transcript-1",
          meeting_id: "meeting-1",
          processing_status: "completed",
          error_code: null,
        },
      ],
      ai_runs: [
        {
          meeting_id: "meeting-1",
          status: "completed",
          summary: "OLDER COMPLETED SUMMARY.",
          validated_output: {
            summary: "OLDER COMPLETED SUMMARY.",
            callRecords: [],
            customerTruthDeltas: [],
            callTypeSpecific: null,
          },
          error_code: null,
          // Deliberately EARLIER than the failed row's created_at below —
          // Codex Pass 3 caught that without a real ordering difference
          // here, this test would pass even against the old buggy
          // "just the newest row by created_at" implementation (the fake
          // client's stable sort on a tie would coincidentally keep this
          // row first). A genuinely later created_at on the failed
          // reprocess is what actually distinguishes "prefers the
          // completed run" from "prefers the newest row."
          created_at: "2026-09-01T01:00:00Z",
          completed_at: "2026-09-01T01:00:00Z",
        },
        {
          meeting_id: "meeting-1",
          status: "failed",
          summary: null,
          validated_output: null,
          error_code: "provider_timeout",
          // A later reprocess attempt — newest by created_at, but failed.
          created_at: "2026-09-05T09:00:00Z",
          completed_at: null,
        },
      ],
      transcript_segments: [],
      call_records: [],
    });

    const state = await getMeetingRecapData(supabase, "meeting-1");

    expect(state?.status).toBe("ready");
    if (state?.status === "ready") {
      expect(state.recap.result.summary).toBe("OLDER COMPLETED SUMMARY.");
    }
  });

  it("reports intelligence_failed only when NO completed run exists at all", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "meeting-1",
          organization_id: "org-1",
          title: "Discovery call",
          customer_id: null,
          call_type: "discovery",
          scheduled_start: "2026-09-01T00:00:00Z",
          actual_start: "2026-09-01T00:00:00Z",
          owner_membership_id: null,
        },
      ],
      meeting_transcripts: [
        {
          id: "transcript-1",
          meeting_id: "meeting-1",
          processing_status: "completed",
          error_code: null,
        },
      ],
      ai_runs: [
        {
          meeting_id: "meeting-1",
          status: "failed",
          summary: null,
          validated_output: null,
          error_code: "provider_timeout",
          completed_at: null,
        },
      ],
      transcript_segments: [],
      call_records: [],
    });

    const state = await getMeetingRecapData(supabase, "meeting-1");
    expect(state).toEqual({
      status: "intelligence_failed",
      errorCode: "provider_timeout",
    });
  });

  it("saves a draft meeting recap into meeting_recaps and appends revision", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "meeting-1",
          organization_id: "org-1",
          owner_membership_id: "mem-am-1",
          customer_id: "cust-1",
        },
      ],
      meeting_recaps: [],
      meeting_recap_revisions: [],
    });

    const res1 = await saveMeetingRecapDraft(supabase, {
      meetingId: "meeting-1",
      actorMembershipId: "mem-am-1",
      greeting: "Hi Candidate,",
      whatWeAgreed: ["Resume reviewed"],
      applyWizzWillDo: ["Apply to 50 jobs"],
      candidateShouldDo: ["Update LinkedIn profile"],
      nextStep: "Check back tomorrow",
    });

    expect(res1.recapId).toBeDefined();
    expect(res1.revisionNumber).toBe(1);
    expect(res1.whatWeAgreed).toEqual(["Resume reviewed"]);
    expect(res1.applyWizzWillDo).toEqual(["Apply to 50 jobs"]);
    expect(res1.candidateShouldDo).toEqual(["Update LinkedIn profile"]);

    const res2 = await saveMeetingRecapDraft(supabase, {
      meetingId: "meeting-1",
      actorMembershipId: "mem-am-1",
      greeting: "Hi Candidate, updated,",
      whatWeAgreed: ["Resume reviewed and approved"],
      applyWizzWillDo: ["Apply to 50 jobs"],
      candidateShouldDo: ["Update LinkedIn profile"],
      nextStep: "Check back Monday",
    });

    expect(res2.recapId).toBe(res1.recapId);
    expect(res2.revisionNumber).toBe(2);
  });

  it("strictly enforces that only the responsible AM can edit or approve recap (Blocker 2)", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "meeting-1",
          organization_id: "org-1",
          owner_membership_id: "responsible-am-id",
          customer_id: "cust-1",
        },
      ],
      meeting_recaps: [
        {
          id: "recap-1",
          organization_id: "org-1",
          meeting_id: "meeting-1",
          status: "draft",
          greeting: "Draft greeting",
          what_we_agreed: [],
          applywizz_will_do: [],
          candidate_should_do: [],
          next_step: "Next",
        },
      ],
      meeting_recap_revisions: [],
      audit_events: [],
    });

    // Unrelated AM / Manager / Admin cannot save draft
    await expect(
      saveMeetingRecapDraft(supabase, {
        meetingId: "meeting-1",
        actorMembershipId: "unrelated-am-or-manager-id",
        greeting: "Hijack",
        nextStep: "Next",
      }),
    ).rejects.toThrow("Only the responsible Account Manager for this meeting can modify or draft the recap.");

    // Unrelated AM / Manager / Admin cannot approve
    await expect(
      approveMeetingRecap(supabase, {
        meetingId: "meeting-1",
        actorUserId: "user-2",
        actorMembershipId: "unrelated-am-or-manager-id",
      }),
    ).rejects.toThrow("Only the responsible Account Manager for this meeting can approve the recap.");

    // Responsible AM is permitted
    const approved = await approveMeetingRecap(supabase, {
      meetingId: "meeting-1",
      actorUserId: "user-am",
      actorMembershipId: "responsible-am-id",
    });
    expect(approved.status).toBe("approved");
  });

  it("preserves exact 3 semantic lists across full round-trip (Blocker 8)", async () => {
    const supabase = fakeSupabase({
      meetings: [
        {
          id: "meeting-roundtrip",
          organization_id: "org-1",
          owner_membership_id: "am-owner-1",
          customer_id: "cust-1",
          call_type: "discovery",
          scheduled_start: "2026-09-10T12:00:00Z",
        },
      ],
      customers: [
        {
          id: "cust-1",
          name: "Rohit Sharma",
          lifecycle_stage: "onboarding",
          owner_membership_id: "am-owner-1",
        },
      ],
      organization_memberships: [
        {
          id: "am-owner-1",
          display_name: "Kiran AM",
        },
      ],
      meeting_recaps: [],
      meeting_recap_revisions: [],
      audit_events: [],
      ai_runs: [
        {
          meeting_id: "meeting-roundtrip",
          status: "completed",
          summary: "Good intro call",
          completed_at: "2026-09-10T13:00:00Z",
          validated_output: {
            summary: "Good intro call",
            callRecords: [
              {
                recordType: "commitment",
                description: "Agreed to target senior distributed roles",
                ownerType: "customer",
              },
              {
                recordType: "action_item",
                description: "ApplyWizz will revise resume bullets",
                ownerType: "applywizz",
              },
              {
                recordType: "action_item",
                description: "Candidate will provide transcript of previous semester",
                ownerType: "customer",
              },
            ],
            customerTruthDeltas: [],
          },
        },
      ],
      call_records: [
        {
          id: "cr-1",
          meeting_id: "meeting-roundtrip",
          organization_id: "org-1",
          record_type: "commitment",
          description: "Agreed to target senior distributed roles",
          owner_type: "customer",
          status: "detected",
          created_at: "2026-09-10T12:30:00Z",
        },
        {
          id: "cr-2",
          meeting_id: "meeting-roundtrip",
          organization_id: "org-1",
          record_type: "action_item",
          description: "ApplyWizz will revise resume bullets",
          owner_type: "applywizz",
          status: "detected",
          created_at: "2026-09-10T12:31:00Z",
        },
        {
          id: "cr-3",
          meeting_id: "meeting-roundtrip",
          organization_id: "org-1",
          record_type: "action_item",
          description: "Candidate will provide transcript of previous semester",
          owner_type: "customer",
          status: "detected",
          created_at: "2026-09-10T12:32:00Z",
        },
      ],
      customer_truth_facts: [],
      meeting_transcripts: [
        {
          id: "tr-1",
          meeting_id: "meeting-roundtrip",
          organization_id: "org-1",
          processing_status: "completed",
        },
      ],
      transcript_segments: [
        {
          id: "seg-1",
          transcript_id: "tr-1",
          sequence_index: 1,
          start_ms: 0,
          end_ms: 30000,
          original_text: "Let's review the plan.",
          canonical_english_text: "Let's review the plan.",
        },
      ],
    });

    // 1. Initial derivation
    const initialData = await getMeetingRecapData(supabase, "meeting-roundtrip");
    expect(initialData?.status).toBe("ready");
    if (!initialData || initialData.status !== "ready" || !initialData.recap.customerSafeRecap) {
      throw new Error("expected ready state");
    }

    expect(initialData.recap.customerSafeRecap.whatWeAgreed).toEqual([
      "Agreed to target senior distributed roles",
    ]);
    expect(initialData.recap.customerSafeRecap.applyWizzWillDo).toEqual([
      "ApplyWizz will revise resume bullets",
    ]);
    expect(initialData.recap.customerSafeRecap.candidateShouldDo).toEqual([
      "Candidate will provide transcript of previous semester",
    ]);

    // 2. Save Draft
    const draftRes = await saveMeetingRecapDraft(supabase, {
      meetingId: "meeting-roundtrip",
      actorMembershipId: "am-owner-1",
      greeting: "Hi Rohit,",
      whatWeAgreed: initialData.recap.customerSafeRecap.whatWeAgreed,
      applyWizzWillDo: initialData.recap.customerSafeRecap.applyWizzWillDo,
      candidateShouldDo: initialData.recap.customerSafeRecap.candidateShouldDo,
      nextStep: "Follow-up on Friday",
    });
    expect(draftRes.revisionNumber).toBe(1);

    // 3. Reload from DB
    const reloaded1 = await getMeetingRecapData(supabase, "meeting-roundtrip");
    if (!reloaded1 || reloaded1.status !== "ready" || !reloaded1.recap.customerSafeRecap) {
      throw new Error("expected ready state 1");
    }
    expect(reloaded1.recap.customerSafeRecap.whatWeAgreed).toEqual([
      "Agreed to target senior distributed roles",
    ]);
    expect(reloaded1.recap.customerSafeRecap.applyWizzWillDo).toEqual([
      "ApplyWizz will revise resume bullets",
    ]);
    expect(reloaded1.recap.customerSafeRecap.candidateShouldDo).toEqual([
      "Candidate will provide transcript of previous semester",
    ]);

    // 4. Edit all three lists
    const updatedWhatWeAgreed = [
      "Agreed to target senior distributed roles",
      "Agreed to open relocation to Austin/Seattle",
    ];
    const updatedApplyWizzWillDo = [
      "ApplyWizz will revise resume bullets",
      "ApplyWizz will curate 15 company referrals",
    ];
    const updatedCandidateShouldDo = [
      "Candidate will provide transcript of previous semester",
      "Candidate will take mock interview assessment",
    ];

    // 5. Save Draft again
    const draftRes2 = await saveMeetingRecapDraft(supabase, {
      meetingId: "meeting-roundtrip",
      actorMembershipId: "am-owner-1",
      greeting: "Hi Rohit Sharma,",
      whatWeAgreed: updatedWhatWeAgreed,
      applyWizzWillDo: updatedApplyWizzWillDo,
      candidateShouldDo: updatedCandidateShouldDo,
      nextStep: "Check in on Monday 10am",
      status: "ready_for_review",
    });
    expect(draftRes2.revisionNumber).toBe(2);
    expect(draftRes2.status).toBe("ready_for_review");

    // 6. Reload from DB after edit
    const reloaded2 = await getMeetingRecapData(supabase, "meeting-roundtrip");
    if (!reloaded2 || reloaded2.status !== "ready" || !reloaded2.recap.customerSafeRecap) {
      throw new Error("expected ready state 2");
    }
    expect(reloaded2.recap.customerSafeRecap.status).toBe("ready_for_review");
    expect(reloaded2.recap.customerSafeRecap.whatWeAgreed).toEqual(updatedWhatWeAgreed);
    expect(reloaded2.recap.customerSafeRecap.applyWizzWillDo).toEqual(updatedApplyWizzWillDo);
    expect(reloaded2.recap.customerSafeRecap.candidateShouldDo).toEqual(updatedCandidateShouldDo);

    // 7. Approve recap
    const approveRes = await approveMeetingRecap(supabase, {
      meetingId: "meeting-roundtrip",
      actorUserId: "user-am-owner",
      actorMembershipId: "am-owner-1",
    });
    expect(approveRes.status).toBe("approved");

    // 8. Reload after approval: all 3 lists remain completely distinct and status is approved
    const reloaded3 = await getMeetingRecapData(supabase, "meeting-roundtrip");
    if (!reloaded3 || reloaded3.status !== "ready" || !reloaded3.recap.customerSafeRecap) {
      throw new Error("expected ready state 3");
    }
    expect(reloaded3.recap.customerSafeRecap.status).toBe("approved");
    expect(reloaded3.recap.customerSafeRecap.whatWeAgreed).toEqual(updatedWhatWeAgreed);
    expect(reloaded3.recap.customerSafeRecap.applyWizzWillDo).toEqual(updatedApplyWizzWillDo);
    expect(reloaded3.recap.customerSafeRecap.candidateShouldDo).toEqual(updatedCandidateShouldDo);
    expect(reloaded3.recap.customerSafeRecap.nextStep).toBe("Check in on Monday 10am");
  });
});

