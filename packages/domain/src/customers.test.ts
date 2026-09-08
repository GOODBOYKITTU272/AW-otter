import { describe, expect, it, vi } from "vitest";
import {
  addCustomerContact,
  createCustomer,
  type AppSupabaseClient,
} from "./customers";

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

describe("createCustomer", () => {
  it("rejects an empty name before ever touching the database", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      customers: (c) => insertSpy(c.payload),
    });

    await expect(
      createCustomer(supabase, {
        organizationId: "org-1",
        name: "   ",
        ownerMembershipId: "am-1",
        actorMembershipId: "am-1",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/name/i);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("creates the customer, sets created_by_membership_id to the actor, and audits it", async () => {
    const insertSpy = vi.fn((_p?: unknown) => ok({ id: "cust-1" }));
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      customers: (c) => insertSpy(c.payload),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await createCustomer(supabase, {
      organizationId: "org-1",
      name: "Acme Corp",
      ownerMembershipId: "am-1",
      actorMembershipId: "admin-1",
      actorUserId: "user-1",
    });

    expect(result).toEqual({ customerId: "cust-1" });
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_membership_id: "am-1",
        created_by_membership_id: "admin-1",
      }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "customer.created" }),
    );
  });
});

describe("addCustomerContact", () => {
  it("turns a unique-constraint violation into a clean, generic domain error", async () => {
    const supabase = createFakeSupabase({
      customer_contacts: () => ({
        data: null,
        error: {
          code: "23505",
          message: "duplicate key value violates unique constraint",
        },
      }),
    });

    await expect(
      addCustomerContact(supabase, {
        organizationId: "org-1",
        customerId: "cust-1",
        email: "a@client.test",
        actorUserId: "user-1",
      }),
    ).rejects.toThrow(/already associated with a customer/i);
  });

  it("adds the contact and audits it", async () => {
    const auditSpy = vi.fn((_p?: unknown) => ok(null));
    const supabase = createFakeSupabase({
      customer_contacts: () => ok({ id: "contact-1" }),
      audit_events: (c) => auditSpy(c.payload),
    });

    const result = await addCustomerContact(supabase, {
      organizationId: "org-1",
      customerId: "cust-1",
      email: "A@Client.test",
      actorUserId: "user-1",
    });

    expect(result).toEqual({ contactId: "contact-1" });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ email: "a@client.test" }),
      }),
    );
  });
});
