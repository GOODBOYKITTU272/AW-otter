import { describe, it, expect } from "vitest";
import {
  detectLobbyAlerts,
  detectCustomerMissingAlerts,
  processLiveAlerts,
  getAMLiveAlerts,
  getManagerLiveAlerts,
  LOBBY_ALERT_THRESHOLD_SECONDS,
  CUSTOMER_MISSING_WARN_MINUTES,
  CUSTOMER_MISSING_ESCALATE_MINUTES,
  type AppSupabaseClient,
} from "./live-alerts";

interface Row {
  [key: string]: unknown;
}

// Minimal fake Supabase client matching operational-incidents.test.ts pattern
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
      not(col: string, _op: string, val: unknown) {
        if (val === null) {
          filtered = filtered.filter((r) => r[col] != null);
        }
        return builder;
      },
      lt(col: string, val: unknown) {
        filtered = filtered.filter((r) => {
          const v = r[col];
          if (typeof v === "string" && typeof val === "string") {
            return v < val;
          }
          return false;
        });
        return builder;
      },
      is(col: string, val: unknown) {
        filtered = filtered.filter((r) => (r[col] ?? null) === val);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        if (mode === "update") {
          if (filtered.length === 0) return { data: null, error: null };
          Object.assign(filtered[0]!, patch);
          return { data: { ...filtered[0]! }, error: null };
        }
        return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
      },
      async single() {
        return { data: filtered[0] ? { ...filtered[0] } : null, error: null };
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        let result: { data: unknown; error: unknown };
        if (mode === "update") {
          for (const row of filtered) Object.assign(row, patch);
          result = { data: filtered.map((r) => ({ ...r })), error: null };
        } else if (mode === "insert") {
          const created: Row = {
            id: `gen-${rows.length + 1}`,
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

describe("detectLobbyAlerts", () => {
  it("returns alerts for bots stuck in lobby beyond threshold", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          last_raw_status: "awaiting_admission",
          status: "joining",
        },
      ],
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Discovery Call",
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectLobbyAlerts(client);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("bot_lobby_stuck");
    expect(alerts[0]?.amMembershipId).toBe("am1");
    expect(alerts[0]?.managerMembershipId).toBe("manager1");
    expect(alerts[0]?.meetingId).toBe("meeting1");
  });

  it("returns no alerts if lobby waiting is within threshold", async () => {
    const recentTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS - 30) * 1000,
    );

    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: recentTime.toISOString(),
          last_raw_status: "awaiting_admission",
          status: "joining",
        },
      ],
      meetings: [],
      organization_memberships: [],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectLobbyAlerts(client);

    expect(alerts).toHaveLength(0);
  });

  it("returns no alerts if no bots are in lobby", async () => {
    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: null,
          last_raw_status: "joined",
          status: "joined",
        },
      ],
      meetings: [],
      organization_memberships: [],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectLobbyAlerts(client);

    expect(alerts).toHaveLength(0);
  });

  it("handles missing manager gracefully", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          status: "joining",
        },
      ],
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Meeting",
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectLobbyAlerts(client);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.managerMembershipId).toBeNull();
  });
});

describe("detectCustomerMissingAlerts", () => {
  it("returns warning alert when customer missing for 10+ minutes", async () => {
    const meetingStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES + 1) * 60 * 1000,
    );
    const botJoinedTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES + 1) * 60 * 1000,
    );

    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      ],
      meeting_bot_jobs: [
        {
          meeting_id: "meeting1",
          joined_at: botJoinedTime.toISOString(),
          status: "joined",
        },
      ],
      meeting_attendees: [
        {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectCustomerMissingAlerts(client);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("customer_missing_warn");
    expect(alerts[0]?.amMembershipId).toBe("am1");
    expect(alerts[0]?.managerMembershipId).toBe("manager1");
  });

  it("returns escalation alert when customer missing for 15+ minutes", async () => {
    const meetingStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_ESCALATE_MINUTES + 1) * 60 * 1000,
    );
    const botJoinedTime = new Date(
      Date.now() - (CUSTOMER_MISSING_ESCALATE_MINUTES + 1) * 60 * 1000,
    );

    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      ],
      meeting_bot_jobs: [
        {
          meeting_id: "meeting1",
          joined_at: botJoinedTime.toISOString(),
          status: "joined",
        },
      ],
      meeting_attendees: [
        {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectCustomerMissingAlerts(client);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("customer_missing_escalate");
  });

  it("returns no alert if external customer is present", async () => {
    const meetingStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES + 1) * 60 * 1000,
    );

    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      ],
      meeting_bot_jobs: [
        {
          meeting_id: "meeting1",
          joined_at: meetingStartTime.toISOString(),
          status: "joined",
        },
      ],
      meeting_attendees: [
        {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
        {
          meeting_id: "meeting1",
          email: "customer@client.com",
          participant_type: "external",
          attended: true,
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectCustomerMissingAlerts(client);

    expect(alerts).toHaveLength(0);
  });

  it("returns no alert if meeting hasn't reached warning threshold", async () => {
    const recentStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES - 2) * 60 * 1000,
    );

    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: recentStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      ],
      meeting_bot_jobs: [],
      meeting_attendees: [],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await detectCustomerMissingAlerts(client);

    expect(alerts).toHaveLength(0);
  });
});

describe("processLiveAlerts", () => {
  it("deduplicates alerts via operational_incidents", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          status: "joining",
        },
      ],
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Meeting",
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      ],
      operational_incidents: [],
    };

    const client = fakeSupabase(tables);

    // First run: should send alert
    const result1 = await processLiveAlerts(client);
    expect(result1.lobbyAlerts).toBe(1);
    expect(result1.totalSent).toBe(1);

    // Second run: should not send duplicate alert (incident already open)
    const result2 = await processLiveAlerts(client);
    expect(result2.lobbyAlerts).toBe(1);
    expect(result2.totalSent).toBe(0); // Deduplicated
  });

  it("counts lobby and customer missing alerts separately", async () => {
    const lobbyThresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );
    const customerMissingTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES + 1) * 60 * 1000,
    );

    const tables: Record<string, Row[]> = {
      meeting_bot_jobs: [
        {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: lobbyThresholdTime.toISOString(),
          status: "joining",
        },
        {
          meeting_id: "meeting2",
          joined_at: customerMissingTime.toISOString(),
          status: "joined",
        },
      ],
      meetings: [
        {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Lobby Meeting",
          lifecycle_status: "upcoming",
        },
        {
          id: "meeting2",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Missing Meeting",
          scheduled_start: customerMissingTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      ],
      meeting_attendees: [
        {
          meeting_id: "meeting2",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      ],
      organization_memberships: [
        {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      ],
      operational_incidents: [],
    };

    const client = fakeSupabase(tables);
    const result = await processLiveAlerts(client);

    expect(result.lobbyAlerts).toBe(1);
    expect(result.customerMissingAlerts).toBe(1);
    expect(result.totalSent).toBe(2);
  });
});

describe("getAMLiveAlerts", () => {
  it("returns open alerts for meetings owned by the AM", async () => {
    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          owner_membership_id: "am1",
          title: "Customer Call",
        },
        {
          id: "meeting2",
          owner_membership_id: "am2",
          title: "Other Call",
        },
      ],
      operational_incidents: [
        {
          id: "incident1",
          organization_id: "org1",
          queue: "live_alerts",
          meeting_id: "meeting1",
          incident_type: "bot_lobby_stuck",
          severity: "warning",
          reason: "bot_lobby_stuck",
          occurrence_count: 1,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          resolved_at: null,
        },
        {
          id: "incident2",
          organization_id: "org1",
          queue: "live_alerts",
          meeting_id: "meeting2",
          incident_type: "customer_missing_warn",
          severity: "warning",
          reason: "customer_missing_warn",
          occurrence_count: 1,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          resolved_at: null,
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await getAMLiveAlerts(client, "am1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("bot_lobby_stuck");
    expect(alerts[0]?.meetingId).toBe("meeting1");
    expect(alerts[0]?.meetingTitle).toBe("Customer Call");
  });

  it("returns empty array if AM has no meetings", async () => {
    const tables: Record<string, Row[]> = {
      meetings: [],
      operational_incidents: [],
    };

    const client = fakeSupabase(tables);
    const alerts = await getAMLiveAlerts(client, "am1");

    expect(alerts).toHaveLength(0);
  });

  it("excludes resolved incidents", async () => {
    const tables: Record<string, Row[]> = {
      meetings: [
        {
          id: "meeting1",
          owner_membership_id: "am1",
          title: "Customer Call",
        },
      ],
      operational_incidents: [
        {
          id: "incident1",
          queue: "live_alerts",
          meeting_id: "meeting1",
          incident_type: "bot_lobby_stuck",
          severity: "warning",
          occurrence_count: 1,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          resolved_at: new Date().toISOString(), // Resolved
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await getAMLiveAlerts(client, "am1");

    expect(alerts).toHaveLength(0);
  });
});

describe("getManagerLiveAlerts", () => {
  it("returns open alerts for meetings owned by direct reports", async () => {
    const tables: Record<string, Row[]> = {
      organization_memberships: [
        {
          id: "am1",
          manager_membership_id: "manager1",
          display_name: "Alice AM",
        },
        {
          id: "am2",
          manager_membership_id: "manager1",
          display_name: "Bob AM",
        },
      ],
      meetings: [
        {
          id: "meeting1",
          owner_membership_id: "am1",
          title: "Alice's Call",
        },
        {
          id: "meeting2",
          owner_membership_id: "am2",
          title: "Bob's Call",
        },
      ],
      operational_incidents: [
        {
          id: "incident1",
          queue: "live_alerts",
          meeting_id: "meeting1",
          incident_type: "customer_missing_escalate",
          severity: "critical",
          occurrence_count: 2,
          first_seen_at: new Date(Date.now() - 600000).toISOString(),
          last_seen_at: new Date().toISOString(),
          resolved_at: null,
        },
      ],
    };

    const client = fakeSupabase(tables);
    const alerts = await getManagerLiveAlerts(client, "manager1");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("customer_missing_escalate");
    expect(alerts[0]?.amName).toBe("Alice AM");
    expect(alerts[0]?.meetingTitle).toBe("Alice's Call");
  });

  it("returns empty array if manager has no direct reports", async () => {
    const tables: Record<string, Row[]> = {
      organization_memberships: [],
      meetings: [],
      operational_incidents: [],
    };

    const client = fakeSupabase(tables);
    const alerts = await getManagerLiveAlerts(client, "manager1");

    expect(alerts).toHaveLength(0);
  });
});
