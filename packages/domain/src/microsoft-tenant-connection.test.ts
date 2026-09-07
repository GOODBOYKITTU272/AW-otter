import { describe, expect, it, vi } from "vitest";
import {
  connectTenantMicrosoft,
  disableTenantMicrosoft,
  getTenantConnectionStatus,
  type AppSupabaseClient,
} from "./microsoft-tenant-connection";

type Handlers = Record<
  string,
  {
    select?: (filters: Record<string, unknown>) => { data: unknown; error: unknown };
    upsert?: (payload: unknown) => { data: unknown; error: unknown };
    update?: (payload: unknown, filters: Record<string, unknown>) => { data: unknown; error: unknown };
    insert?: (payload: unknown) => { data: unknown; error: unknown };
  }
>;

function createFakeSupabase(handlers: Handlers): AppSupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let op: { type: "select" | "insert" | "upsert" | "update"; payload?: unknown } = { type: "select" };

    function resolve() {
      const h = handlers[table] ?? {};
      if (op.type === "insert" && h.insert) return h.insert(op.payload);
      if (op.type === "upsert" && h.upsert) return h.upsert(op.payload);
      if (op.type === "update" && h.update) return h.update(op.payload, filters);
      if (h.select) return h.select(filters);
      return { data: null, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(payload: unknown) {
        op = { type: "insert", payload };
        return builder;
      },
      upsert(payload: unknown) {
        op = { type: "upsert", payload };
        return builder;
      },
      update(payload: unknown) {
        op = { type: "update", payload };
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

function fakeGraphFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const microsoftEnv = { tenantId: "t", clientId: "c", clientSecret: "s", webhookClientState: "cs" };

describe("connectTenantMicrosoft", () => {
  it("verifies the app-only credential before recording success, then audits it", async () => {
    const upsertSpy = vi.fn(() => ({ data: { id: "tenant-conn-1" }, error: null }));
    const auditSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      microsoft_tenant_connections: { upsert: upsertSpy },
      audit_events: { insert: auditSpy },
    });

    const result = await connectTenantMicrosoft(supabase, {
      organizationId: "org-1",
      connectedByMembershipId: "m1",
      actorUserId: "u1",
      microsoftEnv,
      fetchImpl: fakeGraphFetch(200, { access_token: "app-only-at", expires_in: 3600 }),
    });

    expect(result).toEqual({ tenantConnectionId: "tenant-conn-1" });
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: "org-1", status: "active", connected_by_membership_id: "m1" }),
    );
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "microsoft.tenant_sync_enabled", organization_id: "org-1" }),
    );
  });

  it("never records a connection when the app-only credential check fails", async () => {
    const upsertSpy = vi.fn(() => ({ data: { id: "tenant-conn-1" }, error: null }));
    const supabase = createFakeSupabase({
      microsoft_tenant_connections: { upsert: upsertSpy },
    });

    await expect(
      connectTenantMicrosoft(supabase, {
        organizationId: "org-1",
        connectedByMembershipId: "m1",
        actorUserId: "u1",
        microsoftEnv,
        fetchImpl: fakeGraphFetch(401, { error: "invalid_client" }),
      }),
    ).rejects.toThrow();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});

describe("disableTenantMicrosoft", () => {
  it("sets status to disabled and audits it", async () => {
    const updateSpy = vi.fn(() => ({ data: { id: "tenant-conn-1" }, error: null }));
    const auditSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      microsoft_tenant_connections: { update: updateSpy },
      audit_events: { insert: auditSpy },
    });

    await disableTenantMicrosoft(supabase, { organizationId: "org-1", actorUserId: "u1" });

    expect(updateSpy).toHaveBeenCalledWith({ status: "disabled" }, expect.anything());
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "microsoft.tenant_sync_disabled" }),
    );
  });
});

describe("getTenantConnectionStatus", () => {
  it("reports not_connected when no row exists", async () => {
    const supabase = createFakeSupabase({
      microsoft_tenant_connections: { select: () => ({ data: null, error: null }) },
    });
    await expect(getTenantConnectionStatus(supabase, "org-1")).resolves.toEqual({
      status: "not_connected",
      connectedAt: null,
      lastReconciliationResult: null,
    });
  });

  it("reports the connection status and last reconciliation result when present", async () => {
    const supabase = createFakeSupabase({
      microsoft_tenant_connections: {
        select: () => ({
          data: { status: "active", connected_at: "2026-09-01T00:00:00Z", last_reconciliation_result: { eventsSeen: 3 } },
          error: null,
        }),
      },
    });
    await expect(getTenantConnectionStatus(supabase, "org-1")).resolves.toEqual({
      status: "active",
      connectedAt: "2026-09-01T00:00:00Z",
      lastReconciliationResult: { eventsSeen: 3 },
    });
  });
});
