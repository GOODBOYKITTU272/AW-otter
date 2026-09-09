import { describe, expect, it, vi } from "vitest";
import { GraphApiError } from "@applywizz/microsoft";

const renewMicrosoftSubscription = vi.fn();
vi.mock("./microsoft-connection", () => ({
  renewMicrosoftSubscription: (...args: unknown[]) =>
    renewMicrosoftSubscription(...args),
}));

const { renewExpiringMicrosoftSubscriptions } = await import(
  "./microsoft-subscription-renewal"
);
type AppSupabaseClient = Parameters<
  typeof renewExpiringMicrosoftSubscriptions
>[0];

interface Row {
  [key: string]: unknown;
}

// Same shape as the M16 fake clients (operations-recovery.test.ts etc.):
// SELECT returns deep copies (a caller's local `subscription` is a frozen
// snapshot), UPDATE mutates the live canonical array filtered against its
// *current* values — this is what makes the CAS/concurrency test below
// meaningful. renewMicrosoftSubscription itself is mocked (vi.mock above)
// — this file tests ONLY the new orchestration layer's claim/idempotency/
// incident-recording logic, not the already-existing renewal mechanics.
function fakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    let mode: "select" | "update" | "insert" = "select";
    let patch: Row = {};
    let insertRow: Row = {};
    let filtered = rows;

    const builder = {
      select() {
        return builder;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        return builder;
      },
      insert(p: Row) {
        mode = "insert";
        insertRow = p;
        return builder;
      },
      eq(col: string, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      lt(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] as string) < (val as string));
        return builder;
      },
      is(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] ?? null) === val);
        return builder;
      },
      async maybeSingle() {
        if (mode === "update") {
          if (filtered.length === 0) return { data: null, error: null };
          Object.assign(filtered[0]!, patch);
          return { data: { id: filtered[0]!.id }, error: null };
        }
        return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        let result: { data: unknown; error: unknown };
        if (mode === "update") {
          for (const row of filtered) Object.assign(row, patch);
          result = { data: filtered.map((r) => ({ id: r.id })), error: null };
        } else if (mode === "insert") {
          const created: Row = {
            id: `gen-${rows.length + 1}`,
            occurrence_count: 1,
            resolved_at: null,
            ...insertRow,
          };
          rows.push(created);
          result = { data: created, error: null };
        } else {
          result = { data: filtered.map((r) => ({ ...r })), error: null };
        }
        return Promise.resolve(result).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (fn !== "record_operational_incident") {
      throw new Error(`fakeSupabase.rpc: unexpected function ${fn}`);
    }
    const table = tables.operational_incidents ?? (tables.operational_incidents = []);
    const existing = table.find(
      (r) =>
        r.organization_id === args.p_organization_id &&
        r.queue === args.p_queue &&
        r.entity_id === args.p_entity_id &&
        r.incident_type === args.p_incident_type &&
        (r.resolved_at ?? null) === null,
    );
    if (existing) {
      existing.occurrence_count = (existing.occurrence_count as number) + 1;
      existing.last_seen_at = new Date().toISOString();
    } else {
      table.push({
        id: `gen-incident-${table.length + 1}`,
        organization_id: args.p_organization_id,
        queue: args.p_queue,
        entity_id: args.p_entity_id,
        incident_type: args.p_incident_type,
        severity: args.p_severity,
        reason: args.p_reason,
        meeting_id: args.p_meeting_id ?? null,
        occurrence_count: 1,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        resolved_at: null,
      });
    }
    return { data: null, error: null };
  }

  return { from, rpc } as unknown as AppSupabaseClient;
}

const ORG = "org-1";
const now = Date.now();
const soon = new Date(now + 12 * 60 * 60 * 1000).toISOString(); // 12h out — inside the 24h window
const farOut = new Date(now + 60 * 60 * 60 * 1000).toISOString(); // 60h out — outside the window

function baseTables(overrides: Partial<Record<string, Row[]>> = {}) {
  return {
    organization_memberships: [{ id: "m1", organization_id: ORG }],
    calendar_connections: [
      { id: "c1", organization_membership_id: "m1", status: "active" },
    ],
    provider_subscriptions: [],
    operational_incidents: [],
    ...overrides,
  } as Record<string, Row[]>;
}

const microsoftEnv = {} as never;
const encryptionKey = "test-key";

describe("renewExpiringMicrosoftSubscriptions", () => {
  it("renews a subscription inside the renewal window", async () => {
    renewMicrosoftSubscription.mockReset().mockResolvedValue(undefined);
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    const result = await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(result).toEqual({ renewed: 1, failed: 0 });
    expect(renewMicrosoftSubscription).toHaveBeenCalledTimes(1);
    expect(renewMicrosoftSubscription).toHaveBeenCalledWith(
      supabase,
      supabase,
      "s1",
      microsoftEnv,
      encryptionKey,
      undefined,
    );
  });

  it("leaves a subscription that isn't due yet untouched", async () => {
    renewMicrosoftSubscription.mockReset();
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: farOut },
      ],
    });
    const supabase = fakeSupabase(tables);

    const result = await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(result).toEqual({ renewed: 0, failed: 0 });
    expect(renewMicrosoftSubscription).not.toHaveBeenCalled();
    expect(tables.provider_subscriptions![0]!.status).toBe("active");
  });

  it("on a transient renewal failure, reverts the claim and records a warning incident (not critical)", async () => {
    renewMicrosoftSubscription
      .mockReset()
      .mockRejectedValue(new Error("network blip"));
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    const result = await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(result).toEqual({ renewed: 0, failed: 1 });
    expect(tables.provider_subscriptions![0]!.status).toBe("active"); // reverted, not stuck "renewing"
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.severity).toBe("warning");
  });

  it("on a 404 (subscription no longer exists on Graph), records a critical incident and does not loop forever locally", async () => {
    renewMicrosoftSubscription
      .mockReset()
      .mockRejectedValue(new GraphApiError(404, "ResourceNotFound", "Subscription not found."));
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(tables.operational_incidents![0]!.severity).toBe("critical");
    expect(tables.operational_incidents![0]!.incident_type).toBe("renewal_failed");
  });

  it("two concurrent sweeps cannot both renew the same subscription (CAS claim)", async () => {
    renewMicrosoftSubscription.mockReset().mockResolvedValue(undefined);
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    const [a, b] = await Promise.all([
      renewExpiringMicrosoftSubscriptions(supabase, supabase, ORG, microsoftEnv, encryptionKey),
      renewExpiringMicrosoftSubscriptions(supabase, supabase, ORG, microsoftEnv, encryptionKey),
    ]);

    expect(a.renewed + b.renewed).toBe(1);
    expect(renewMicrosoftSubscription).toHaveBeenCalledTimes(1);
  });

  it("scopes renewal to the given organization only", async () => {
    renewMicrosoftSubscription.mockReset().mockResolvedValue(undefined);
    const tables = baseTables({
      organization_memberships: [
        { id: "m1", organization_id: ORG },
        { id: "m2", organization_id: "org-2" },
      ],
      calendar_connections: [
        { id: "c1", organization_membership_id: "m1", status: "active" },
        { id: "c2", organization_membership_id: "m2", status: "active" },
      ],
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
        { id: "s2", calendar_connection_id: "c2", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    const result = await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(result.renewed).toBe(1);
    expect(renewMicrosoftSubscription).toHaveBeenCalledWith(
      supabase,
      supabase,
      "s1",
      microsoftEnv,
      encryptionKey,
      undefined,
    );
    const other = tables.provider_subscriptions!.find((r) => r.id === "s2")!;
    expect(other.status).toBe("active");
  });

  it("review fix: never sweeps a subscription belonging to a disconnected calendar connection", async () => {
    renewMicrosoftSubscription.mockReset().mockResolvedValue(undefined);
    const tables = baseTables({
      calendar_connections: [
        { id: "c1", organization_membership_id: "m1", status: "disconnected" },
      ],
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    const result = await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    expect(result).toEqual({ renewed: 0, failed: 0 });
    expect(renewMicrosoftSubscription).not.toHaveBeenCalled();
    expect(tables.provider_subscriptions![0]!.status).toBe("active");
  });

  it("review fix: a disconnect racing an in-flight renewal wins — the failed-renewal revert does not resurrect a row something else already changed", async () => {
    const tables = baseTables({
      provider_subscriptions: [
        { id: "s1", calendar_connection_id: "c1", status: "active", expires_at: soon },
      ],
    });
    const supabase = fakeSupabase(tables);

    // Simulates disconnectMicrosoftConnection's own update landing on this
    // exact row WHILE this renewal call is in flight (after our CAS claim
    // already flipped it to "renewing", before our own update runs) —
    // then the renewal itself fails, e.g. because the token it needed was
    // just invalidated by that same disconnect.
    renewMicrosoftSubscription.mockReset().mockImplementation(async () => {
      const row = tables.provider_subscriptions!.find((r) => r.id === "s1")!;
      expect(row.status).toBe("renewing"); // our claim landed first
      row.status = "cancelled"; // the concurrent disconnect's write
      throw new Error("token invalidated by concurrent disconnect");
    });

    await renewExpiringMicrosoftSubscriptions(
      supabase,
      supabase,
      ORG,
      microsoftEnv,
      encryptionKey,
    );

    // Must stay "cancelled" — the CAS-guarded revert (.eq("status",
    // "renewing")) must not match anymore and must not overwrite it back
    // to "active".
    expect(tables.provider_subscriptions![0]!.status).toBe("cancelled");
  });
});
