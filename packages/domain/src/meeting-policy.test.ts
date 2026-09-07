import { describe, expect, it, vi } from "vitest";
import { evaluateMeetingPolicy, evaluateOrganizationMeetings, type AppSupabaseClient } from "./meeting-policy";

interface Call {
  op: "select" | "insert" | "upsert" | "update" | "delete";
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

const baseMeeting = {
  organization_id: "org-1",
  owner_membership_id: "owner-1",
  meeting_type: "teams",
  meeting_url: "https://teams.example/x",
  lifecycle_status: "upcoming",
  eligibility_status: "pending",
};

const allRulesEnabled = [
  { rule_type: "organization_disabled", enabled: true, params: {}, reason_code: "org disabled" },
  { rule_type: "employee_mi_disabled", enabled: true, params: {}, reason_code: "mi disabled" },
  { rule_type: "unsupported_mechanism", enabled: true, params: {}, reason_code: "unsupported" },
  { rule_type: "approved_exemption", enabled: true, params: {}, reason_code: "exemption approved" },
  { rule_type: "sensitive_internal", enabled: true, params: {}, reason_code: "internal only" },
  { rule_type: "role_team", enabled: false, params: {}, reason_code: "role/team" },
  { rule_type: "external_client", enabled: true, params: {}, reason_code: "external attendee" },
  { rule_type: "org_default", enabled: true, params: {}, reason_code: "org default" },
];

function baseTableHandlers(overrides: Partial<Record<string, TableHandler>> = {}): Record<string, TableHandler> {
  return {
    meetings: (call) => (call.op === "select" ? ok(baseMeeting) : ok(null)),
    meeting_policy_sets: () => ok({ id: "policy-set-1", default_decision: "record" }),
    meeting_policy_rules: () => ok(allRulesEnabled),
    organizations: () => ok({ status: "active", email_domain: null }),
    organization_memberships: () => ok({ meeting_ai_enabled: true }),
    recording_exemption_requests: () => ok(null),
    meeting_attendees: () => ok([]),
    meeting_policy_decisions: () => ok(null),
    ...overrides,
  };
}

describe("evaluateMeetingPolicy", () => {
  it("skips cancelled meetings entirely — no write, no decision row", async () => {
    const updateSpy = vi.fn(() => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) => (call.op === "select" ? ok({ ...baseMeeting, lifecycle_status: "cancelled" }) : updateSpy()),
    });
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("skips a meeting mid-review (pending_exception) without touching it", async () => {
    const updateSpy = vi.fn(() => ok(null));
    const supabase = createFakeSupabase({
      meetings: (call) => (call.op === "select" ? ok({ ...baseMeeting, eligibility_status: "pending_exception" }) : updateSpy()),
    });
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toBeNull();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("decides 'pending' when the meeting has no owner yet — awaiting attribution, not a real decision", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        meetings: (call) => (call.op === "select" ? ok({ ...baseMeeting, owner_membership_id: null }) : ok(null)),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "pending", ruleType: null, reasonCode: expect.any(String) });
  });

  it("falls through to org_default ('record') when nothing else fires", async () => {
    const supabase = createFakeSupabase(baseTableHandlers());
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "record", ruleType: "org_default", reasonCode: "org default" });
  });

  it("organization_disabled takes top priority over everything else", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        organizations: () => ok({ status: "suspended", email_domain: null }),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "exclude", ruleType: "organization_disabled", reasonCode: "org disabled" });
  });

  it("employee_mi_disabled fires when the owner has Meeting Intelligence off", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        organization_memberships: () => ok({ meeting_ai_enabled: false }),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "exclude", ruleType: "employee_mi_disabled", reasonCode: "mi disabled" });
  });

  it("unsupported_mechanism fires for a non-Teams meeting", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        meetings: (call) => (call.op === "select" ? ok({ ...baseMeeting, meeting_type: "in_person" }) : ok(null)),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "unsupported", ruleType: "unsupported_mechanism", reasonCode: "unsupported" });
  });

  it("approved_exemption excludes when an approved request exists for the meeting", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        recording_exemption_requests: () => ok({ id: "req-1" }),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "exclude", ruleType: "approved_exemption", reasonCode: "exemption approved" });
  });

  it("sensitive_internal excludes an all-internal meeting when email_domain is configured", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        organizations: () => ok({ status: "active", email_domain: "applywizz.test" }),
        meeting_attendees: () => ok([{ email: "someone@applywizz.test" }]),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "exclude", ruleType: "sensitive_internal", reasonCode: "internal only" });
  });

  it("external_client applies its configured decision when an attendee is outside the org domain", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        organizations: () => ok({ status: "active", email_domain: "applywizz.test" }),
        meeting_attendees: () => ok([{ email: "client@othercompany.test" }]),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result).toEqual({ decision: "record", ruleType: "external_client", reasonCode: "external attendee" });
  });

  it("a disabled rule never fires, even when its condition is true", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        organizations: () => ok({ status: "suspended", email_domain: null }),
        meeting_policy_rules: () =>
          ok(allRulesEnabled.map((r) => (r.rule_type === "organization_disabled" ? { ...r, enabled: false } : r))),
      }),
    );
    const result = await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(result?.ruleType).not.toBe("organization_disabled");
  });

  it("writes both the meetings.eligibility_status update and a meeting_policy_decisions row", async () => {
    const meetingsUpdateSpy = vi.fn((_payload?: unknown) => ok(null));
    const decisionsInsertSpy = vi.fn((_payload?: unknown) => ok(null));
    const supabase = createFakeSupabase(
      baseTableHandlers({
        meetings: (call) => (call.op === "select" ? ok(baseMeeting) : meetingsUpdateSpy(call.payload)),
        meeting_policy_decisions: (call) => decisionsInsertSpy(call.payload),
      }),
    );
    await evaluateMeetingPolicy(supabase, "meeting-1");
    expect(meetingsUpdateSpy).toHaveBeenCalledWith({ eligibility_status: "record" });
    expect(decisionsInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ meeting_id: "meeting-1", organization_id: "org-1", decision: "record", rule_type: "org_default" }),
    );
  });
});

describe("evaluateOrganizationMeetings", () => {
  it("evaluates every upcoming meeting for the org and aggregates decisions", async () => {
    const supabase = createFakeSupabase(
      baseTableHandlers({
        meetings: (call) => {
          if (call.op === "select" && call.filters.organization_id) {
            return ok([{ id: "m1" }, { id: "m2" }]);
          }
          if (call.op === "select") return ok(baseMeeting);
          return ok(null);
        },
      }),
    );
    const result = await evaluateOrganizationMeetings(supabase, "org-1");
    expect(result).toEqual({ meetingsEvaluated: 2, decisions: { record: 2 } });
  });

  it("returns zero when the org has no upcoming meetings", async () => {
    const supabase = createFakeSupabase({
      meetings: () => ok([]),
    });
    const result = await evaluateOrganizationMeetings(supabase, "org-1");
    expect(result).toEqual({ meetingsEvaluated: 0, decisions: {} });
  });
});
