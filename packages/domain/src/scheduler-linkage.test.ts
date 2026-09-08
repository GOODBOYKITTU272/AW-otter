import { describe, expect, it } from "vitest";
import {
  mapExternalCallType,
  normalizeTeamsLink,
  reconcileOrganizationSchedulerCalls,
  type AppSupabaseClient,
} from "./scheduler-linkage";
import type { SchedulerCall } from "@applywizz/scheduler";

describe("mapExternalCallType", () => {
  it("maps every known scheduler type to its canonical Signal value", () => {
    expect(mapExternalCallType("DISCOVERY")).toBe("discovery");
    expect(mapExternalCallType("ORIENTATION")).toBe("orientation");
    expect(mapExternalCallType("PROGRESS_REVIEW")).toBe("progress");
    expect(mapExternalCallType("RENEWAL_DISCUSSION")).toBe("renewal");
  });

  it("falls back to other_unknown for an unrecognized value, never throws", () => {
    expect(mapExternalCallType("RESUME_REVIEW")).toBe("other_unknown");
    expect(mapExternalCallType("")).toBe("other_unknown");
  });
});

describe("normalizeTeamsLink", () => {
  it("strips query-string context and trailing slash, lowercases", () => {
    const a = normalizeTeamsLink(
      "https://teams.microsoft.com/l/meetup-join/19:MEETING_abc@thread.v2/0?context=%7B%22Tid%22%3A%221%22%7D",
    );
    const b = normalizeTeamsLink(
      "https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0/",
    );
    expect(a).toBe(b);
  });

  it("returns null for null/empty input", () => {
    expect(normalizeTeamsLink(null)).toBeNull();
    expect(normalizeTeamsLink("")).toBeNull();
    expect(normalizeTeamsLink("   ")).toBeNull();
  });

  it("falls back to a lowercase/trim for a non-URL value rather than throwing", () => {
    expect(normalizeTeamsLink("Not A Url")).toBe("not a url");
  });
});

// --- Stateful in-memory fake, purpose-built for this module's real
// multi-table upsert/query orchestration (a static per-call handler, as
// used by customer-linkage.test.ts, can't represent upsert-by-unique-key
// or cross-call idempotency). Deep schema/constraint guarantees (RLS,
// uniqueness, org-consistency triggers) are covered by pgTAP instead —
// this fake only needs to be correct enough to exercise scheduler-
// linkage.ts's own control flow.
interface Row {
  [key: string]: unknown;
}

class FakeTable {
  rows: Row[] = [];
  constructor(
    public uniqueKeys: string[][] = [],
    public idPrefix = "row",
  ) {}
  private nextId = 1;
  genId(): string {
    return `${this.idPrefix}-${this.nextId++}`;
  }
}

function matchesFilters(row: Row, filters: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith("is_")) {
      const col = key.slice(3);
      if (value === null ? row[col] !== null : row[col] !== value) return false;
    } else if (key.startsWith("in_")) {
      const col = key.slice(3);
      if (!(value as unknown[]).includes(row[col])) return false;
    } else if (key.startsWith("gte_")) {
      const col = key.slice(4);
      if (!(new Date(row[col] as string) >= new Date(value as string)))
        return false;
    } else if (key.startsWith("lte_")) {
      const col = key.slice(4);
      if (!(new Date(row[col] as string) <= new Date(value as string)))
        return false;
    } else if (key.startsWith("not_null_")) {
      const col = key.slice(9);
      if (row[col] === null || row[col] === undefined) return false;
    } else if (key === "__or__") {
      const clauses = value as { col: string; op: string; val: unknown }[];
      const anyMatch = clauses.some((c) => {
        if (c.op === "is") return row[c.col] === c.val;
        if (c.op === "eq") return row[c.col] === c.val;
        return false;
      });
      if (!anyMatch) return false;
    } else {
      if (row[key] !== value) return false;
    }
  }
  return true;
}

function createStatefulFakeSupabase(
  tables: Record<string, FakeTable>,
): AppSupabaseClient {
  function from(tableName: string) {
    const table = tables[tableName];
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" | "upsert" = "select";
    let payload: Row | undefined;
    let onConflict: string | undefined;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    function parseOrClause(expr: string) {
      // "customer_link_status.is.null,customer_link_status.eq.needs_link"
      const clauses = expr.split(",").map((part) => {
        const [col, op, ...rest] = part.split(".");
        const raw = rest.join(".");
        return { col, op, val: raw === "null" ? null : raw };
      });
      filters.__or__ = clauses;
    }

    function currentRows(): Row[] {
      let rows = (table?.rows ?? []).filter((r) => matchesFilters(r, filters));
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = new Date(a[orderCol as string] as string).getTime();
          const bv = new Date(b[orderCol as string] as string).getTime();
          return orderAsc ? av - bv : bv - av;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    function applyWrite(): {
      data: Row | Row[] | null;
      error: { code?: string; message?: string } | null;
    } {
      if (!table) return { data: null, error: null };

      if (op === "insert") {
        const newRow: Row = { id: table.genId(), ...payload };
        for (const keySet of table.uniqueKeys) {
          const dup = table.rows.some((r) =>
            keySet.every((k) => r[k] === newRow[k]),
          );
          if (dup)
            return {
              data: null,
              error: { code: "23505", message: "duplicate key" },
            };
        }
        table.rows.push(newRow);
        return { data: newRow, error: null };
      }

      if (op === "upsert") {
        const keySet = onConflict?.split(",") ?? [];
        const existingIdx = table.rows.findIndex((r) =>
          keySet.every((k) => r[k] === (payload as Row)[k]),
        );
        if (existingIdx >= 0) {
          table.rows[existingIdx] = { ...table.rows[existingIdx], ...payload };
          return { data: table.rows[existingIdx], error: null };
        }
        const newRow: Row = { id: table.genId(), meeting_id: null, ...payload };
        table.rows.push(newRow);
        return { data: newRow, error: null };
      }

      // update
      const matched = currentRows();
      for (const row of matched) {
        Object.assign(row, payload);
      }
      return {
        data: matched.length > 0 ? (matched[0] ?? null) : null,
        error: null,
      };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(p: Row) {
        op = "insert";
        payload = p;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      upsert(p: Row, opts?: { onConflict?: string }) {
        op = "upsert";
        payload = p;
        onConflict = opts?.onConflict;
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
      gte(column: string, value: unknown) {
        filters[`gte_${column}`] = value;
        return builder;
      },
      lte(column: string, value: unknown) {
        filters[`lte_${column}`] = value;
        return builder;
      },
      not(column: string, _op: string, _value: unknown) {
        filters[`not_null_${column}`] = true;
        return builder;
      },
      or(expr: string) {
        parseOrClause(expr);
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderCol = column;
        orderAsc = opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        if (op === "select") {
          const rows = currentRows();
          return { data: rows[0] ?? null, error: null };
        }
        return applyWrite();
      },
      async single() {
        if (op === "select") {
          const rows = currentRows();
          return {
            data: rows[0] ?? null,
            error: rows[0] ? null : { message: "not found" },
          };
        }
        const result = applyWrite();
        return result.data && !Array.isArray(result.data)
          ? result
          : { data: (result.data as Row[])?.[0] ?? null, error: result.error };
      },
      then(
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        const result =
          op === "select" ? { data: currentRows(), error: null } : applyWrite();
        const normalized =
          op !== "select" && !Array.isArray(result.data)
            ? { data: result.data ? [result.data] : [], error: result.error }
            : result;
        return Promise.resolve(normalized).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  // Mirrors claim_scheduler_call_meeting (migration 050003) — the single
  // atomic-claim RPC scheduler-linkage.ts now calls instead of two
  // separate .update() round-trips, so this fake needs to model the same
  // "both writes or neither" transaction shape, not just individual table
  // ops.
  async function rpc(fnName: string, args: Record<string, unknown>) {
    if (fnName !== "claim_scheduler_call_meeting") {
      return { data: null, error: { message: `unmocked rpc: ${fnName}` } };
    }
    const schedulerCalls = tables.scheduler_calls;
    const meetingsTable = tables.meetings;
    if (!schedulerCalls || !meetingsTable) return { data: false, error: null };

    const callRow = schedulerCalls.rows.find(
      (r) =>
        r.id === args.p_scheduler_call_id &&
        r.organization_id === args.p_organization_id &&
        r.meeting_id === null,
    );
    if (!callRow) return { data: false, error: null };
    callRow.meeting_id = args.p_meeting_id;

    const meetingRow = meetingsTable.rows.find(
      (r) =>
        r.id === args.p_meeting_id &&
        r.organization_id === args.p_organization_id &&
        (r.customer_link_status === null ||
          r.customer_link_status === "needs_link"),
    );
    if (!meetingRow) {
      callRow.meeting_id = null; // same-transaction release, mirrors the SQL function
      return { data: false, error: null };
    }

    meetingRow.customer_id = args.p_customer_id;
    meetingRow.customer_link_status = "linked_auto";
    meetingRow.needs_link_reason = null;
    meetingRow.linked_at = new Date().toISOString();
    meetingRow.linked_by_membership_id = null;
    meetingRow.call_type = args.p_call_type;
    meetingRow.call_type_source = "external_scheduler";

    return { data: true, error: null };
  }

  return { from, rpc } as unknown as AppSupabaseClient;
}

function makeTables() {
  const orgMemberships = new FakeTable([], "mem");
  const roles = new FakeTable([], "role");
  const customers = new FakeTable(
    [["organization_id", "external_applywizz_id"]],
    "cust",
  );
  const customerContacts = new FakeTable(
    [["organization_id", "email"]],
    "contact",
  );
  const schedulerCalls = new FakeTable(
    [["organization_id", "external_call_id"]],
    "sched",
  );
  const meetings = new FakeTable([], "meet");
  const meetingExternalEvents = new FakeTable([], "mee");
  const auditEvents = new FakeTable([], "audit");

  roles.rows.push({
    id: "role-am",
    organization_id: null,
    key: "account_manager",
  });
  orgMemberships.rows.push({
    id: "am-sarika",
    organization_id: "org-1",
    work_email: "sarika@applywizz.com",
    role_id: "role-am",
    status: "active",
  });

  return {
    organization_memberships: orgMemberships,
    roles,
    customers,
    customer_contacts: customerContacts,
    scheduler_calls: schedulerCalls,
    meetings,
    meeting_external_events: meetingExternalEvents,
    audit_events: auditEvents,
  };
}

function fakeCall(overrides: Partial<SchedulerCall> = {}): SchedulerCall {
  return {
    externalCallId: "call-1",
    leadId: "AWL-1",
    clientName: "Client One",
    clientEmail: "client1@example.com",
    amEmail: "sarika@applywizz.com",
    externalType: "DISCOVERY",
    scheduledAt: "2026-09-10T10:00:00Z",
    endsAt: "2026-09-10T10:30:00Z",
    externalStatus: "SCHEDULED",
    teamsLink: null,
    teamsEventId: null,
    teamsOnlineMeetingId: null,
    sourceCreatedAt: "2026-09-01T00:00:00Z",
    sourceUpdatedAt: null,
    ...overrides,
  };
}

function fetchImplReturning(calls: SchedulerCall[]) {
  return async () =>
    new Response(
      JSON.stringify({
        success: true,
        calls: calls.map((c) => ({
          id: c.externalCallId,
          lead_id: c.leadId,
          client_name: c.clientName,
          client_email: c.clientEmail,
          am_email: c.amEmail,
          type: c.externalType,
          scheduled_at: c.scheduledAt,
          ends_at: c.endsAt,
          status: c.externalStatus,
          teams_link: c.teamsLink,
          teams_event_id: c.teamsEventId,
          teams_online_meeting_id: c.teamsOnlineMeetingId,
          created_at: c.sourceCreatedAt,
          updated_at: c.sourceUpdatedAt,
        })),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

describe("reconcileOrganizationSchedulerCalls", () => {
  it("creates one customer + one scheduler_calls row from a lead_id, with external_scheduler source", async () => {
    const tables = makeTables();
    const supabase = createStatefulFakeSupabase(tables);

    const result = await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall()]),
    );

    expect(result.customersCreated).toBe(1);
    expect(tables.customers.rows).toHaveLength(1);
    expect(tables.customers.rows[0]?.source_type).toBe("external_scheduler");
    expect(tables.customers.rows[0]?.external_applywizz_id).toBe("AWL-1");
    expect(tables.scheduler_calls.rows).toHaveLength(1);
    expect(tables.scheduler_calls.rows[0]?.canonical_call_type).toBe(
      "discovery",
    );
    expect(tables.scheduler_calls.rows[0]?.call_type_source).toBe(
      "external_scheduler",
    );
  });

  it("is idempotent: syncing the same lead_id/call twice does not duplicate the customer or the scheduler_calls row", async () => {
    const tables = makeTables();
    const supabase = createStatefulFakeSupabase(tables);

    await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall()]),
    );
    const secondResult = await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall()]),
    );

    expect(secondResult.customersCreated).toBe(0);
    expect(tables.customers.rows).toHaveLength(1);
    expect(tables.scheduler_calls.rows).toHaveLength(1);
  });

  it("does not silently merge two different lead_ids that share the same client_email", async () => {
    const tables = makeTables();
    const supabase = createStatefulFakeSupabase(tables);

    await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([
        fakeCall({
          externalCallId: "call-1",
          leadId: "AWL-1",
          clientEmail: "shared@example.com",
        }),
      ]),
    );
    await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([
        fakeCall({
          externalCallId: "call-2",
          leadId: "AWL-2",
          clientEmail: "shared@example.com",
        }),
      ]),
    );

    expect(tables.customers.rows).toHaveLength(2);
    expect(
      new Set(tables.customers.rows.map((r) => r.external_applywizz_id)),
    ).toEqual(new Set(["AWL-1", "AWL-2"]));
    // The email stays pointed at whichever customer claimed it first — never repointed.
    expect(tables.customer_contacts.rows).toHaveLength(1);
    expect(tables.customer_contacts.rows[0]?.customer_id).toBe(
      tables.customers.rows[0]?.id,
    );
  });

  it("skips a call whose am_email does not resolve to an active managed membership", async () => {
    const tables = makeTables();
    const supabase = createStatefulFakeSupabase(tables);

    const result = await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall({ amEmail: "unknown-am@applywizz.com" })]),
    );

    // The AM roster loop itself only queries sarika (the one seeded active AM),
    // so this simulates a row appearing under an am_email that isn't a managed membership.
    expect(result.customersCreated).toBe(0);
    expect(tables.customers.rows).toHaveLength(0);
    expect(tables.scheduler_calls.rows).toHaveLength(0);
  });

  it("Tier 1: links to the meeting found via meeting_external_events when teams_event_id matches", async () => {
    const tables = makeTables();
    tables.meetings.rows.push({
      id: "meeting-1",
      organization_id: "org-1",
      owner_membership_id: "am-sarika",
      customer_link_status: null,
      customer_id: null,
      scheduled_start: "2026-09-10T10:00:00Z",
      meeting_url: null,
    });
    tables.meeting_external_events.rows.push({
      organization_id: "org-1",
      provider: "microsoft",
      provider_user_key: "sarika@applywizz.com",
      external_event_id: "graph-evt-1",
      is_organizer: true,
      meeting_id: "meeting-1",
    });
    const supabase = createStatefulFakeSupabase(tables);

    const result = await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall({ teamsEventId: "graph-evt-1" })]),
    );

    expect(result.callsLinkedToMeetings).toBe(1);
    expect(tables.meetings.rows[0]?.customer_link_status).toBe("linked_auto");
    expect(tables.meetings.rows[0]?.call_type).toBe("discovery");
    expect(tables.meetings.rows[0]?.call_type_source).toBe(
      "external_scheduler",
    );
    expect(tables.scheduler_calls.rows[0]?.meeting_id).toBe("meeting-1");
  });

  it("never re-evaluates a scheduler_calls row that already has a meeting_id (terminal, idempotent)", async () => {
    const tables = makeTables();
    tables.meetings.rows.push({
      id: "meeting-1",
      organization_id: "org-1",
      owner_membership_id: "am-sarika",
      customer_link_status: "linked_auto",
      customer_id: "cust-x",
      scheduled_start: "2026-09-10T10:00:00Z",
      meeting_url: null,
    });
    tables.scheduler_calls.rows.push({
      id: "sched-1",
      organization_id: "org-1",
      external_call_id: "call-1",
      customer_id: "cust-x",
      external_applywizz_id: "AWL-1",
      owner_membership_id: "am-sarika",
      meeting_id: "meeting-1",
    });
    tables.customers.rows.push({
      id: "cust-x",
      organization_id: "org-1",
      external_applywizz_id: "AWL-1",
      owner_membership_id: "am-sarika",
      name: "Client One",
    });
    const supabase = createStatefulFakeSupabase(tables);

    const result = await reconcileOrganizationSchedulerCalls(
      supabase,
      "org-1",
      "https://scheduler.test",
      fetchImplReturning([fakeCall({ teamsEventId: "graph-evt-1" })]),
    );

    expect(result.callsLinkedToMeetings).toBe(0);
    expect(tables.meetings.rows[0]?.customer_id).toBe("cust-x"); // untouched
  });
});
