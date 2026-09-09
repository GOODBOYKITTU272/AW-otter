import { describe, expect, it, vi } from "vitest";
import {
  requestDoNotRecord,
  reviewException,
  runExceptionMaintenance,
  type AppSupabaseClient,
} from "./recording-exceptions";

interface Call {
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type TableHandler = (call: Call) => { data: unknown; error: unknown };

function createFakeSupabase(handlers: Record<string, TableHandler>): AppSupabaseClient {
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

  return { from } as unknown as AppSupabaseClient;
}

function ok(data: unknown = null) {
  return { data, error: null };
}

describe("requestDoNotRecord", () => {
  it("rejects an empty/whitespace-only reason before ever touching the database", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({ recording_exemption_requests: (c) => insertSpy(c.payload) });
    await expect(
      requestDoNotRecord(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        requestedByMembershipId: "am-1",
        actorUserId: "user-1",
        reason: "   ",
      }),
    ).rejects.toThrow(/reason/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("inserts the request, flips the meeting to pending_exception, and audits it", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok({ id: "req-1" }));
    const meetingUpdateSpy = vi.fn((_p?: unknown) => ok(null));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => (c.op === "insert" ? insertSpy(c.payload) : ok(null)),
      meetings: (c) => meetingUpdateSpy(c.payload),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await requestDoNotRecord(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      requestedByMembershipId: "am-1",
      actorUserId: "user-1",
      reason: "  Client asked us not to record.  ",
    });

    expect(result).toEqual({ requestId: "req-1" });
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ meeting_id: "m1", requested_by: "am-1", reason: "Client asked us not to record." }),
    );
    expect(meetingUpdateSpy).toHaveBeenCalledWith({ eligibility_status: "pending_exception" });
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "recording_exception.requested" }));
  });
});

describe("reviewException", () => {
  it("approving: updates status, resets the meeting for re-evaluation, and audits 'approved'", async () => {
    const requestUpdateSpy = vi.fn((_p?: unknown) => ok({ meeting_id: "m1" }));
    const meetingsUpdateSpy = vi.fn((_p?: unknown) => ok(null));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const meetingRow = {
      organization_id: "org-1",
      owner_membership_id: "owner-1",
      meeting_type: "teams",
      meeting_url: "https://teams.example/x",
      lifecycle_status: "upcoming",
      eligibility_status: "pending",
    };
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => requestUpdateSpy(c.payload),
      meetings: (c) => (c.op === "select" ? ok(meetingRow) : meetingsUpdateSpy(c.payload)),
      meeting_policy_sets: () => ok({ id: "ps-1", default_decision: "record" }),
      meeting_policy_rules: () => ok([]),
      organizations: () => ok({ status: "active", email_domain: null }),
      organization_memberships: () => ok({ meeting_ai_enabled: true }),
      meeting_attendees: () => ok([]),
      meeting_policy_decisions: () => ok(null),
      audit_events: (c) => auditSpy(c.payload),
    });

    await reviewException(supabase, supabase, {
      requestId: "req-1",
      organizationId: "org-1",
      reviewerMembershipId: "mgr-1",
      actorUserId: "user-mgr",
      decision: "approved",
      reviewNotes: "confirmed",
    });

    expect(requestUpdateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "approved", reviewed_by: "mgr-1", review_notes: "confirmed" }),
    );
    // First meetings write resets the sticky guard, second is evaluateMeetingPolicy's own decision write.
    expect(meetingsUpdateSpy).toHaveBeenNthCalledWith(1, { eligibility_status: "pending" });
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "recording_exception.approved" }));
  });

  it("rejecting audits 'rejected', not 'approved'", async () => {
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const meetingRow = {
      organization_id: "org-1",
      owner_membership_id: "owner-1",
      meeting_type: "teams",
      meeting_url: "https://teams.example/x",
      lifecycle_status: "upcoming",
      eligibility_status: "pending",
    };
    const supabase = createFakeSupabase({
      recording_exemption_requests: () => ok({ meeting_id: "m1" }),
      meetings: (c) => (c.op === "select" ? ok(meetingRow) : ok(null)),
      meeting_policy_sets: () => ok({ id: "ps-1", default_decision: "record" }),
      meeting_policy_rules: () => ok([]),
      organizations: () => ok({ status: "active", email_domain: null }),
      organization_memberships: () => ok({ meeting_ai_enabled: true }),
      meeting_attendees: () => ok([]),
      meeting_policy_decisions: () => ok(null),
      audit_events: (c) => auditSpy(c.payload),
    });

    await reviewException(supabase, supabase, {
      requestId: "req-1",
      organizationId: "org-1",
      reviewerMembershipId: "mgr-1",
      actorUserId: "user-mgr",
      decision: "rejected",
    });

    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "recording_exception.rejected" }));
  });
});

describe("runExceptionMaintenance", () => {
  it("cancels a pending request whose meeting was cancelled, and audits it — no email/notes needed", async () => {
    // M17B: the CAS-guarded update now does .select("id").maybeSingle() —
    // must return a truthy row (a real match) for the caller to treat the
    // claim as won, matching what a genuine CAS-matched update returns.
    const requestUpdateSpy = vi.fn((_p?: unknown) => ok({ id: "req-1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => {
        if (c.op === "select") return ok([{ id: "req-1", meeting_id: "m1" }]);
        return requestUpdateSpy(c.payload);
      },
      meetings: () => ok({ lifecycle_status: "cancelled", scheduled_start: new Date().toISOString() }),
      meeting_policy_sets: () => ok({ cutoff_minutes_before_start: 0 }),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await runExceptionMaintenance(supabase, "org-1");

    expect(result.cancelledForCancelledMeetings).toBe(1);
    expect(requestUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "recording_exception.cancelled_meeting_cancelled", actor_id: null }),
    );
  });

  it("M17B concurrency fix: if another (concurrent) run already claimed the request — the CAS update matches no row — this run does not double-audit or double-count", async () => {
    // ok(null) here simulates the real CAS predicate (.eq("status",
    // "requested")) matching zero rows because another overlapping
    // scheduled invocation already flipped this exact row to "cancelled"
    // moments earlier — the shape a genuinely lost race actually returns.
    const requestUpdateSpy = vi.fn((_p?: unknown) => ok(null));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => {
        if (c.op === "select") return ok([{ id: "req-1", meeting_id: "m1" }]);
        return requestUpdateSpy(c.payload);
      },
      meetings: () => ok({ lifecycle_status: "cancelled", scheduled_start: new Date().toISOString() }),
      meeting_policy_sets: () => ok({ cutoff_minutes_before_start: 0 }),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await runExceptionMaintenance(supabase, "org-1");

    expect(result.cancelledForCancelledMeetings).toBe(0);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("resolves a request past cutoff to expired, re-evaluates the meeting, and audits it", async () => {
    // M17B: same CAS-claim-must-return-a-row requirement as above.
    const requestUpdateSpy = vi.fn((_p?: unknown) => ok({ id: "req-1" }));
    const meetingsUpdateSpy = vi.fn((_p?: unknown) => ok(null));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    let requestedCallCount = 0;
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => {
        if (c.op === "select") {
          requestedCallCount += 1;
          // First select is cancelExceptionsForCancelledMeetings' own
          // query, second is resolveCutoffExceptions' — both look
          // identical to this fake, return the same pending request both
          // times (harmless: the meeting isn't cancelled, so the first
          // pass no-ops on it).
          return ok([{ id: "req-1", meeting_id: "m1" }]);
        }
        return requestUpdateSpy(c.payload);
      },
      meetings: (c) => {
        if (c.op === "select") {
          return ok({ lifecycle_status: "upcoming", scheduled_start: new Date(Date.now() - 60_000).toISOString() });
        }
        return meetingsUpdateSpy(c.payload);
      },
      meeting_policy_sets: () => ok({ cutoff_minutes_before_start: 0 }),
      meeting_policy_rules: () => ok([]),
      organizations: () => ok({ status: "active", email_domain: null }),
      organization_memberships: () => ok({ meeting_ai_enabled: true }),
      meeting_attendees: () => ok([]),
      meeting_policy_decisions: () => ok(null),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await runExceptionMaintenance(supabase, "org-1");

    expect(result.resolvedAtCutoff).toBe(1);
    expect(requestedCallCount).toBeGreaterThanOrEqual(1);
    expect(requestUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "expired" }));
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ action: "recording_exception.expired_at_cutoff" }));
  });

  it("leaves a not-yet-due request alone", async () => {
    const requestUpdateSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      recording_exemption_requests: (c) => (c.op === "select" ? ok([{ id: "req-1", meeting_id: "m1" }]) : requestUpdateSpy(c.payload)),
      meetings: () => ok({ lifecycle_status: "upcoming", scheduled_start: new Date(Date.now() + 60 * 60_000).toISOString() }),
      meeting_policy_sets: () => ok({ cutoff_minutes_before_start: 0 }),
    });

    const result = await runExceptionMaintenance(supabase, "org-1");

    expect(result).toEqual({ cancelledForCancelledMeetings: 0, resolvedAtCutoff: 0 });
    expect(requestUpdateSpy).not.toHaveBeenCalled();
  });
});
