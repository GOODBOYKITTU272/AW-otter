import { describe, expect, it, vi } from "vitest";
import {
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
