import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectLobbyAlerts,
  detectCustomerMissingAlerts,
  processLiveAlerts,
  LOBBY_ALERT_THRESHOLD_SECONDS,
  CUSTOMER_MISSING_WARN_MINUTES,
  CUSTOMER_MISSING_ESCALATE_MINUTES,
} from "./live-alerts";

// Mock Supabase client builder (same pattern as no-customer-policy.test.ts)
type Row = Record<string, unknown>;
type Table = { [key: string]: Row[] };

function ok(data: Row | Row[]) {
  return { data, error: null };
}

function err(message: string) {
  return { data: null, error: { message } };
}

function createFakeClient(tables: Record<string, Table>) {
  const seenCalls: string[] = [];

  return {
    from: (tableName: string) => {
      const table = tables[tableName] ?? {};
      let filters: Record<string, unknown> = {};
      let selectColumns = "*";
      let singleMode = false;
      let maybeSingleMode = false;
      let orderBy: { column: string; ascending: boolean } | null = null;
      let limitValue: number | null = null;

      const builder: any = {
        select: (cols?: string) => {
          selectColumns = cols ?? "*";
          return builder;
        },
        insert: (row: Row) => {
          seenCalls.push(`insert:${tableName}`);
          const id = String(Object.keys(table).length + 1);
          table[id] = { ...row, id };
          return builder;
        },
        update: (patch: Row) => {
          seenCalls.push(`update:${tableName}`);
          const matching = Object.values(table).filter((r) => {
            return Object.entries(filters).every(
              ([k, v]) => r[k as keyof Row] === v,
            );
          });
          for (const row of matching) {
            Object.assign(row, patch);
          }
          return builder;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return builder;
        },
        in: (col: string, vals: unknown[]) => {
          filters[`${col}:in`] = vals;
          return builder;
        },
        not: (col: string, op: string, val: unknown) => {
          if (op === "is" && val === null) {
            filters[`${col}:not_null`] = true;
          }
          return builder;
        },
        lt: (col: string, val: unknown) => {
          filters[`${col}:lt`] = val;
          return builder;
        },
        is: (col: string, val: unknown) => {
          if (val === null) {
            filters[`${col}:is_null`] = true;
          }
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          orderBy = { column: col, ascending: opts?.ascending ?? true };
          return builder;
        },
        limit: (n: number) => {
          limitValue = n;
          return builder;
        },
        single: () => {
          singleMode = true;
          return builder;
        },
        maybeSingle: () => {
          maybeSingleMode = true;
          return builder;
        },
        then: async (resolve: (result: unknown) => void) => {
          seenCalls.push(`query:${tableName}:${selectColumns}`);
          let results = Object.values(table);

          // Apply filters
          results = results.filter((r) => {
            return Object.entries(filters).every(([k, v]) => {
              if (k.endsWith(":in")) {
                const col = k.replace(":in", "");
                return (v as unknown[]).includes(r[col as keyof Row]);
              }
              if (k.endsWith(":not_null")) {
                const col = k.replace(":not_null", "");
                return r[col as keyof Row] != null;
              }
              if (k.endsWith(":is_null")) {
                const col = k.replace(":is_null", "");
                return r[col as keyof Row] == null;
              }
              if (k.endsWith(":lt")) {
                const col = k.replace(":lt", "");
                return (r[col as keyof Row] as string) < (v as string);
              }
              return r[k as keyof Row] === v;
            });
          });

          // Apply ordering
          if (orderBy) {
            const { column, ascending } = orderBy;
            results.sort((a, b) => {
              const aVal = a[column as keyof Row];
              const bVal = b[column as keyof Row];
              if (aVal < bVal) return ascending ? -1 : 1;
              if (aVal > bVal) return ascending ? 1 : -1;
              return 0;
            });
          }

          // Apply limit
          if (limitValue !== null) {
            results = results.slice(0, limitValue);
          }

          if (singleMode) {
            resolve(ok(results[0] ?? null));
          } else if (maybeSingleMode) {
            resolve(ok(results[0] ?? null));
          } else {
            resolve(ok(results));
          }
        },
      };

      return builder;
    },
    rpc: (fn: string, params: Record<string, unknown>) => {
      seenCalls.push(`rpc:${fn}`);
      if (fn === "record_operational_incident") {
        const table =
          tables.operational_incidents ?? (tables.operational_incidents = {});
        const id = String(Object.keys(table).length + 1);
        table[id] = {
          id,
          organization_id: params.p_organization_id,
          queue: params.p_queue,
          entity_id: params.p_entity_id,
          incident_type: params.p_incident_type,
          severity: params.p_severity,
          reason: params.p_reason,
          meeting_id: params.p_meeting_id,
          occurrence_count: 1,
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          resolved_at: null,
        };
      }
      return { then: (resolve: (result: unknown) => void) => resolve(ok(null)) };
    },
  };
}

describe("detectLobbyAlerts", () => {
  it("returns alerts for bots stuck in lobby beyond threshold", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          last_raw_status: "awaiting_admission",
          status: "joining",
        },
      },
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Discovery Call",
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectLobbyAlerts(client as never);

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

    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: recentTime.toISOString(),
          last_raw_status: "awaiting_admission",
          status: "joining",
        },
      },
      meetings: {},
      organization_memberships: {},
    };

    const client = createFakeClient(tables);
    const alerts = await detectLobbyAlerts(client as never);

    expect(alerts).toHaveLength(0);
  });

  it("returns no alerts if no bots are in lobby", async () => {
    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: null,
          last_raw_status: "joined",
          status: "joined",
        },
      },
      meetings: {},
      organization_memberships: {},
    };

    const client = createFakeClient(tables);
    const alerts = await detectLobbyAlerts(client as never);

    expect(alerts).toHaveLength(0);
  });

  it("handles missing manager gracefully", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          status: "joining",
        },
      },
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Meeting",
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectLobbyAlerts(client as never);

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

    const tables: Record<string, Table> = {
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      },
      meeting_bot_jobs: {
        job1: {
          meeting_id: "meeting1",
          joined_at: botJoinedTime.toISOString(),
          status: "joined",
        },
      },
      meeting_attendees: {
        attendee1: {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectCustomerMissingAlerts(client as never);

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

    const tables: Record<string, Table> = {
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      },
      meeting_bot_jobs: {
        job1: {
          meeting_id: "meeting1",
          joined_at: botJoinedTime.toISOString(),
          status: "joined",
        },
      },
      meeting_attendees: {
        attendee1: {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: "manager1",
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectCustomerMissingAlerts(client as never);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alertType).toBe("customer_missing_escalate");
  });

  it("returns no alert if external customer is present", async () => {
    const meetingStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES + 1) * 60 * 1000,
    );

    const tables: Record<string, Table> = {
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: meetingStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      },
      meeting_bot_jobs: {
        job1: {
          meeting_id: "meeting1",
          joined_at: meetingStartTime.toISOString(),
          status: "joined",
        },
      },
      meeting_attendees: {
        attendee1: {
          meeting_id: "meeting1",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
        attendee2: {
          meeting_id: "meeting1",
          email: "customer@client.com",
          participant_type: "external",
          attended: true,
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectCustomerMissingAlerts(client as never);

    expect(alerts).toHaveLength(0);
  });

  it("returns no alert if meeting hasn't reached warning threshold", async () => {
    const recentStartTime = new Date(
      Date.now() - (CUSTOMER_MISSING_WARN_MINUTES - 2) * 60 * 1000,
    );

    const tables: Record<string, Table> = {
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Call",
          scheduled_start: recentStartTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      },
      meeting_bot_jobs: {},
      meeting_attendees: {},
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      },
    };

    const client = createFakeClient(tables);
    const alerts = await detectCustomerMissingAlerts(client as never);

    expect(alerts).toHaveLength(0);
  });
});

describe("processLiveAlerts", () => {
  it("deduplicates alerts via operational_incidents", async () => {
    const thresholdTime = new Date(
      Date.now() - (LOBBY_ALERT_THRESHOLD_SECONDS + 10) * 1000,
    );

    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: thresholdTime.toISOString(),
          status: "joining",
        },
      },
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Meeting",
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      },
      operational_incidents: {},
    };

    const client = createFakeClient(tables);

    // First run: should send alert
    const result1 = await processLiveAlerts(client as never);
    expect(result1.lobbyAlerts).toBe(1);
    expect(result1.totalSent).toBe(1);

    // Second run: should not send duplicate alert (incident already open)
    const result2 = await processLiveAlerts(client as never);
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

    const tables: Record<string, Table> = {
      meeting_bot_jobs: {
        job1: {
          id: "job1",
          meeting_id: "meeting1",
          organization_id: "org1",
          lobby_waiting_since: lobbyThresholdTime.toISOString(),
          status: "joining",
        },
        job2: {
          meeting_id: "meeting2",
          joined_at: customerMissingTime.toISOString(),
          status: "joined",
        },
      },
      meetings: {
        meeting1: {
          id: "meeting1",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Lobby Meeting",
        },
        meeting2: {
          id: "meeting2",
          organization_id: "org1",
          owner_membership_id: "am1",
          title: "Customer Missing Meeting",
          scheduled_start: customerMissingTime.toISOString(),
          lifecycle_status: "upcoming",
        },
      },
      meeting_attendees: {
        attendee1: {
          meeting_id: "meeting2",
          email: "am@company.com",
          participant_type: "organizer",
          attended: true,
        },
      },
      organization_memberships: {
        am1: {
          id: "am1",
          organization_id: "org1",
          work_email: "am@company.com",
          manager_membership_id: null,
        },
      },
      operational_incidents: {},
    };

    const client = createFakeClient(tables);
    const result = await processLiveAlerts(client as never);

    expect(result.lobbyAlerts).toBe(1);
    expect(result.customerMissingAlerts).toBe(1);
    expect(result.totalSent).toBe(2);
  });
});
