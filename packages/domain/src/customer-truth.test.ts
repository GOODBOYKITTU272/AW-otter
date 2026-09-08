import { describe, expect, it, vi } from "vitest";
import {
  confirmCustomerTruthFact,
  rejectCustomerTruthFact,
  seedCustomerTruthFact,
  type AppSupabaseClient,
} from "./customer-truth";

interface Call {
  op: "select" | "insert";
  payload?: unknown;
}

type TableHandler = (call: Call) => { data: unknown; error: unknown };

function createFakeSupabase(
  handlers: Record<string, TableHandler>,
): AppSupabaseClient {
  function from(table: string) {
    let op: Call["op"] = "select";
    let payload: unknown;

    function resolve() {
      const handler = handlers[table];
      if (!handler) return { data: null, error: null };
      return handler({ op, payload });
    }

    const builder = {
      insert(p: unknown) {
        op = "insert";
        payload = p;
        return builder;
      },
      select() {
        return builder;
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

describe("seedCustomerTruthFact", () => {
  it("rejects an empty field_key before ever touching the database", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      customer_truth_facts: (c) => insertSpy(c.payload),
    });

    await expect(
      seedCustomerTruthFact(supabase, {
        organizationId: "org-1",
        customerId: "cust-1",
        fieldKey: "  ",
        value: "backend",
        sourceType: "manual",
        confirmedByMembershipId: "am-1",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/field_key/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("always writes status='confirmed' — manual/onboarding seeding never leaves a fact proposed", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok({ id: "fact-1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      customer_truth_facts: (c) => insertSpy(c.payload),
      audit_events: (c) => auditSpy(c.payload),
    });

    await seedCustomerTruthFact(supabase, {
      organizationId: "org-1",
      customerId: "cust-1",
      fieldKey: "target_roles",
      value: "backend",
      sourceType: "onboarding_form",
      confirmedByMembershipId: "am-1",
      actorUserId: "user-1",
    });

    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "confirmed",
        source_type: "onboarding_form",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "customer_truth.seeded" }),
    );
  });
});

function fakeRpcSupabase(response: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as AppSupabaseClient, rpc };
}

describe("confirmCustomerTruthFact", () => {
  it("calls confirm_customer_truth_fact and returns the confirmed row", async () => {
    const row = { id: "fact-1", status: "confirmed" };
    const { client, rpc } = fakeRpcSupabase({ data: row, error: null });

    const result = await confirmCustomerTruthFact(client, "fact-1");

    expect(rpc).toHaveBeenCalledWith("confirm_customer_truth_fact", {
      p_fact_id: "fact-1",
    });
    expect(result).toEqual(row);
  });

  it("throws the RPC error (e.g. an unauthorized/blocked-transition rejection) rather than swallowing it", async () => {
    const { client } = fakeRpcSupabase({
      data: null,
      error: new Error("Cannot confirm a fact with status rejected."),
    });
    await expect(confirmCustomerTruthFact(client, "fact-1")).rejects.toThrow(
      /Cannot confirm/,
    );
  });
});

describe("rejectCustomerTruthFact", () => {
  it("calls reject_customer_truth_fact with the given reason and returns the rejected row", async () => {
    const row = { id: "fact-1", status: "rejected" };
    const { client, rpc } = fakeRpcSupabase({ data: row, error: null });

    const result = await rejectCustomerTruthFact(
      client,
      "fact-1",
      "not accurate",
    );

    expect(rpc).toHaveBeenCalledWith("reject_customer_truth_fact", {
      p_fact_id: "fact-1",
      p_reason: "not accurate",
    });
    expect(result).toEqual(row);
  });

  it("passes null when no reason is given", async () => {
    const { client, rpc } = fakeRpcSupabase({
      data: { id: "fact-1" },
      error: null,
    });
    await rejectCustomerTruthFact(client, "fact-1");
    expect(rpc).toHaveBeenCalledWith("reject_customer_truth_fact", {
      p_fact_id: "fact-1",
      p_reason: null,
    });
  });
});
