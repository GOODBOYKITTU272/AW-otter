import { describe, expect, it, vi } from "vitest";
import {
  confirmCallType,
  evaluateMeetingCustomerLinkage,
  linkMeetingToCustomer,
  reconcileOrganizationCustomerLinkage,
  unlinkMeeting,
  type AppSupabaseClient,
} from "./customer-linkage";

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
      is(column: string, value: unknown) {
        filters[`is_${column}`] = value;
        return builder;
      },
      in(column: string, values: unknown) {
        filters[`in_${column}`] = values;
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

const baseMeeting = {
  id: "m1",
  organization_id: "org-1",
  owner_membership_id: "am-1",
  eligibility_status: "record",
  lifecycle_status: "upcoming",
  customer_id: null,
  customer_link_status: null,
};

describe("evaluateMeetingCustomerLinkage", () => {
  it("auto-links when exactly one external attendee matches a contact owned by the same AM", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "customer@client.test" }]),
      customer_contacts: () => ok([{ customer_id: "cust-1" }]),
      customers: () => ok([{ id: "cust-1", owner_membership_id: "am-1" }]),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "linked_auto" });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: "cust-1",
        customer_link_status: "linked_auto",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting_customer.linked_auto" }),
    );
  });

  it("flags needs_link with reason 'no_match' when no contact matches any external attendee", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "nobody@client.test" }]),
      customer_contacts: () => ok([]),
      audit_events: () => ok(null),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "needs_link", reason: "no_match" });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_link_status: "needs_link",
        needs_link_reason: "no_match",
      }),
    );
  });

  it("flags needs_link with reason 'multiple_matches' when two different same-AM customers match", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () =>
        ok([{ email: "a@client.test" }, { email: "b@client.test" }]),
      customer_contacts: () =>
        ok([{ customer_id: "cust-1" }, { customer_id: "cust-2" }]),
      customers: () =>
        ok([
          { id: "cust-1", owner_membership_id: "am-1" },
          { id: "cust-2", owner_membership_id: "am-1" },
        ]),
      audit_events: () => ok(null),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({
      status: "needs_link",
      reason: "multiple_matches",
    });
  });

  it("flags needs_link with reason 'owner_conflict' when the only match belongs to a different AM", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "customer@client.test" }]),
      customer_contacts: () => ok([{ customer_id: "cust-2" }]),
      customers: () => ok([{ id: "cust-2", owner_membership_id: "am-OTHER" }]),
      audit_events: () => ok(null),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "needs_link", reason: "owner_conflict" });
  });

  it("never auto-links an internal-only meeting — skips without ever writing needs_link", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "colleague@orgp.test" }]),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "skipped" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("is idempotent — a meeting already linked_auto is never re-evaluated", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              ...baseMeeting,
              customer_link_status: "linked_auto",
              customer_id: "cust-1",
            })
          : updateSpy(c.payload),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "skipped" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("respects a deliberate 'unlinked' decision — repeated reconciliation does not re-link it", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({ ...baseMeeting, customer_link_status: "unlinked" })
          : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "customer@client.test" }]),
      customer_contacts: () => ok([{ customer_id: "cust-1" }]),
      customers: () => ok([{ id: "cust-1", owner_membership_id: "am-1" }]),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "skipped" });
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("sets customer_link_status='cancelled' when the meeting's lifecycle_status is cancelled", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              ...baseMeeting,
              lifecycle_status: "cancelled",
              customer_link_status: "needs_link",
            })
          : updateSpy(c.payload),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(updateSpy).toHaveBeenCalledWith({
      customer_link_status: "cancelled",
    });
  });

  it("does not overwrite a concurrent manual link — a CAS miss on the auto-link write is treated as skipped, not an error", async () => {
    // Simulates the exact race Codex's plan review flagged: reconciliation
    // read customer_link_status='needs_link', but by the time it writes,
    // an AM has already manually linked it to a different customer — the
    // CAS-guarded update matches zero rows.
    const updateSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" ? ok(baseMeeting) : updateSpy(c.payload),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "customer@client.test" }]),
      customer_contacts: () => ok([{ customer_id: "cust-1" }]),
      customers: () => ok([{ id: "cust-1", owner_membership_id: "am-1" }]),
    });

    const result = await evaluateMeetingCustomerLinkage(
      supabase,
      "m1",
      "org-1",
    );

    expect(result).toEqual({ status: "skipped" });
  });
});

describe("reconcileOrganizationCustomerLinkage", () => {
  it("scans every upcoming and cancelled meeting in the organization", async () => {
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select" &&
        c.filters.organization_id === "org-1" &&
        c.filters.in_lifecycle_status
          ? ok([{ id: "m1" }, { id: "m2" }])
          : ok(baseMeeting),
      organizations: () => ok({ email_domain: "orgp.test" }),
      meeting_attendees: () => ok([{ email: "colleague@orgp.test" }]),
    });

    const result = await reconcileOrganizationCustomerLinkage(
      supabase,
      "org-1",
    );

    expect(result.meetingsScanned).toBe(2);
  });
});

describe("linkMeetingToCustomer / unlinkMeeting", () => {
  it("links a meeting to a customer owned by the same AM and audits it as a fresh link", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: null,
            })
          : updateSpy(c.payload),
      customers: () => ok({ id: "cust-1", owner_membership_id: "am-1" }),
      audit_events: (c) => auditSpy(c.payload),
    });

    await linkMeetingToCustomer(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      customerId: "cust-1",
      actorMembershipId: "am-1",
      actorRoleKey: "account_manager",
      actorUserId: "user-1",
    });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting_customer.linked_manual" }),
    );
  });

  it("audits as 'corrected' when the meeting was already linked", async () => {
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: "linked_auto",
            })
          : ok({ id: "m1" }),
      customers: () => ok({ id: "cust-2", owner_membership_id: "am-1" }),
      audit_events: (c) => auditSpy(c.payload),
    });

    await linkMeetingToCustomer(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      customerId: "cust-2",
      actorMembershipId: "am-1",
      actorRoleKey: "account_manager",
      actorUserId: "user-1",
    });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting_customer.corrected" }),
    );
  });

  it("rejects linking a meeting to a customer owned by a different AM", async () => {
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: null,
            })
          : ok(null),
      customers: () => ok({ id: "cust-1", owner_membership_id: "am-OTHER" }),
    });

    await expect(
      linkMeetingToCustomer(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        customerId: "cust-1",
        actorMembershipId: "am-1",
        actorRoleKey: "account_manager",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/same account manager/i);
  });

  it("rejects a manager who can merely read the meeting (e.g. via exception-review scope) but doesn't own it and isn't admin", async () => {
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: null,
            })
          : ok(null),
      customers: () => ok({ id: "cust-1", owner_membership_id: "am-1" }),
    });

    await expect(
      linkMeetingToCustomer(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        customerId: "cust-1",
        actorMembershipId: "manager-1",
        actorRoleKey: "manager",
        actorUserId: "user-manager",
      }),
    ).rejects.toThrow(/not authorized to manage/i);
  });

  it("allows an admin to correct a meeting they don't personally own", async () => {
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: null,
            })
          : ok({ id: "m1" }),
      customers: () => ok({ id: "cust-1", owner_membership_id: "am-1" }),
      audit_events: (c) => auditSpy(c.payload),
    });

    await linkMeetingToCustomer(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      customerId: "cust-1",
      actorMembershipId: "admin-1",
      actorRoleKey: "admin",
      actorUserId: "user-admin",
    });

    expect(auditSpy).toHaveBeenCalled();
  });

  it("does not let two concurrent corrections FROM the same 'linked_manual' status both win — CAS also guards the observed customer_id", async () => {
    // The gap Codex's post-implementation review found: status alone is
    // insufficient once the starting state is already 'linked_manual',
    // since correcting to a different customer doesn't change status at
    // all. Both callers observe customer_id='cust-OLD'; the fake here
    // simulates the update matching zero rows once a first write has
    // already changed customer_id away from what this caller expects.
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_id: "cust-OLD",
              customer_link_status: "linked_manual",
            })
          : ok(null), // the CAS-guarded update matches zero rows
      customers: () => ok({ id: "cust-NEW", owner_membership_id: "am-1" }),
    });

    await expect(
      linkMeetingToCustomer(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        customerId: "cust-NEW",
        actorMembershipId: "am-1",
        actorRoleKey: "account_manager",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/changed elsewhere/i);
  });

  it("surfaces a conflict, not a silent failure, when the manual link's CAS write loses a race", async () => {
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_link_status: "needs_link",
            })
          : ok(null),
      customers: () => ok({ id: "cust-1", owner_membership_id: "am-1" }),
    });

    await expect(
      linkMeetingToCustomer(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        customerId: "cust-1",
        actorMembershipId: "am-1",
        actorRoleKey: "account_manager",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/changed elsewhere/i);
  });

  it("leaves a needs_link meeting unlinked and audits 'left_unlinked' (no prior link existed)", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok({ id: "m1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_id: null,
              customer_link_status: "needs_link",
            })
          : updateSpy(c.payload),
      audit_events: (c) => auditSpy(c.payload),
    });

    await unlinkMeeting(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      actorMembershipId: "am-1",
      actorRoleKey: "account_manager",
      actorUserId: "user-1",
    });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: null,
        customer_link_status: "unlinked",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting_customer.left_unlinked" }),
    );
  });

  it("removes an EXISTING link and audits 'unlinked' (distinct from 'left_unlinked')", async () => {
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({
              id: "m1",
              owner_membership_id: "am-1",
              customer_id: "cust-1",
              customer_link_status: "linked_auto",
            })
          : ok({ id: "m1" }),
      audit_events: (c) => auditSpy(c.payload),
    });

    await unlinkMeeting(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      actorMembershipId: "am-1",
      actorRoleKey: "account_manager",
      actorUserId: "user-1",
    });

    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting_customer.unlinked",
        metadata: expect.objectContaining({ previousCustomerId: "cust-1" }),
      }),
    );
  });

  it("rejects a manager unlinking a meeting they don't own and aren't admin for", async () => {
    const supabase = createFakeSupabase({
      meetings: () =>
        ok({
          id: "m1",
          owner_membership_id: "am-1",
          customer_id: "cust-1",
          customer_link_status: "linked_auto",
        }),
    });

    await expect(
      unlinkMeeting(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        actorMembershipId: "manager-1",
        actorRoleKey: "manager",
        actorUserId: "user-manager",
      }),
    ).rejects.toThrow(/not authorized to manage/i);
  });
});

describe("confirmCallType", () => {
  it("confirms a call type on a linked meeting and audits it", async () => {
    const updateSpy = vi.fn((_p?: unknown) => ok(null));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      meetings: (c) =>
        c.op === "select"
          ? ok({ id: "m1", owner_membership_id: "am-1", customer_id: "cust-1" })
          : updateSpy(c.payload),
      audit_events: (c) => auditSpy(c.payload),
    });

    await confirmCallType(supabase, supabase, {
      meetingId: "m1",
      organizationId: "org-1",
      callType: "discovery",
      actorMembershipId: "am-1",
      actorRoleKey: "account_manager",
      actorUserId: "user-1",
    });

    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        call_type: "discovery",
        call_type_source: "am_confirmed",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meeting_call_type.confirmed" }),
    );
  });

  it("rejects confirming a call type before the meeting is linked to a customer", async () => {
    const supabase = createFakeSupabase({
      meetings: () =>
        ok({ id: "m1", owner_membership_id: "am-1", customer_id: null }),
    });

    await expect(
      confirmCallType(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        callType: "discovery",
        actorMembershipId: "am-1",
        actorRoleKey: "account_manager",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/link this meeting/i);
  });

  it("rejects a manager confirming call type on a meeting they don't own and aren't admin for", async () => {
    const supabase = createFakeSupabase({
      meetings: () =>
        ok({ id: "m1", owner_membership_id: "am-1", customer_id: "cust-1" }),
    });

    await expect(
      confirmCallType(supabase, supabase, {
        meetingId: "m1",
        organizationId: "org-1",
        callType: "discovery",
        actorMembershipId: "manager-1",
        actorRoleKey: "manager",
        actorUserId: "user-manager",
      }),
    ).rejects.toThrow(/not authorized to manage/i);
  });
});
