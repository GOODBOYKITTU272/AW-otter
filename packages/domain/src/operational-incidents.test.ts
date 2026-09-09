import { describe, expect, it } from "vitest";
import {
  recordIncident,
  resolveIncident,
  listOpenIncidents,
  type AppSupabaseClient,
} from "./operational-incidents";

interface Row {
  [key: string]: unknown;
}

// Minimal in-memory fake: SELECT reads return deep copies (so a caller's
// local variable is disconnected from later mutations); UPDATE/INSERT
// mutate the live canonical array in place, filtered synchronously against
// its *current* values — this is what makes the CAS-style tests in
// operations-recovery.test.ts meaningful, and here just gives realistic
// read-then-write semantics. `.rpc()` simulates record_operational_
// incident's real atomic upsert-or-bump (insert .. on conflict .. do
// update set occurrence_count = +1); the real Postgres function's own
// atomicity under concurrency is proven at the pgTAP level (022_
// operational_incidents_dedup_and_bump.test.sql), not here — this fake
// just proves recordIncident calls through with the right arguments and
// produces the right observable behavior.
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
      is(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] ?? null) === val);
        return builder;
      },
      order() {
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
const KEY = {
  organizationId: ORG,
  queue: "transcription",
  entityId: "t1",
  incidentType: "stuck",
} as const;

describe("recordIncident / resolveIncident / listOpenIncidents", () => {
  it("a new incident emits exactly one open row", async () => {
    const tables: Record<string, Row[]> = { operational_incidents: [] };
    const supabase = fakeSupabase(tables);
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.resolved_at).toBeNull();
    expect(tables.operational_incidents![0]!.occurrence_count).toBe(1);
  });

  it("a second call for the same open key bumps occurrence_count instead of inserting again", async () => {
    const tables: Record<string, Row[]> = { operational_incidents: [] };
    const supabase = fakeSupabase(tables);
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    expect(tables.operational_incidents).toHaveLength(1);
    expect(tables.operational_incidents![0]!.occurrence_count).toBe(3);
  });

  it("resolving then recording again creates a genuinely new row (a fresh alert)", async () => {
    const tables: Record<string, Row[]> = { operational_incidents: [] };
    const supabase = fakeSupabase(tables);
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    await resolveIncident(supabase, KEY);
    await recordIncident(supabase, { ...KEY, severity: "critical", reason: "worker_stuck_timeout" });

    expect(tables.operational_incidents).toHaveLength(2);
    const resolved = tables.operational_incidents!.filter((r) => r.resolved_at !== null);
    const open = tables.operational_incidents!.filter((r) => r.resolved_at === null);
    expect(resolved).toHaveLength(1);
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrence_count).toBe(1);
  });

  it("listOpenIncidents excludes resolved rows and never carries transcript-shaped content — reason is always the fixed coded string", async () => {
    const tables: Record<string, Row[]> = { operational_incidents: [] };
    const supabase = fakeSupabase(tables);
    await recordIncident(supabase, { ...KEY, severity: "warning", reason: "worker_stuck_timeout" });
    await recordIncident(supabase, {
      ...KEY,
      entityId: "t2",
      severity: "critical",
      reason: "worker_stuck_timeout: retries exhausted",
    });
    await resolveIncident(supabase, { ...KEY, entityId: "t2" });

    const open = await listOpenIncidents(supabase, ORG);
    expect(open).toHaveLength(1);
    expect(open[0]!.entityId).toBe("t1");
    for (const incident of open) {
      expect(incident.reason).not.toMatch(/[a-z]+@|http|transcript|\d{3}-\d{2}-\d{4}/i);
    }
  });
});
