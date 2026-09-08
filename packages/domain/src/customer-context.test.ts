import { describe, expect, it, vi } from "vitest";
import {
  CustomerHasNoExternalIdentityError,
  CustomerNotVisibleError,
  getEffectiveCustomerTruth,
  hydrateCustomerCrmBaseline,
  isSemanticallySameValue,
  type AppSupabaseClient,
} from "./customer-context";

vi.mock("@applywizz/crm", async () => {
  const actual =
    await vi.importActual<typeof import("@applywizz/crm")>("@applywizz/crm");
  return {
    ...actual,
    getCustomerDetails: vi.fn(),
  };
});
import { getCustomerDetails } from "@applywizz/crm";

interface Row {
  [key: string]: unknown;
}

function fakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
    const rows = tables[table] ?? [];
    const filters: Record<string, unknown> = {};
    let insertPayload: Row | undefined;
    let op: "select" | "insert" = "select";
    let orderCol: string | null = null;
    let limitN: number | null = null;

    const builder = {
      select() {
        return builder;
      },
      insert(p: Row) {
        op = "insert";
        insertPayload = p;
        return builder;
      },
      eq(col: string, value: unknown) {
        filters[col] = value;
        return builder;
      },
      order(col: string) {
        orderCol = col;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        if (op === "insert") {
          const dup = rows.some(
            (r) =>
              r.customer_id === insertPayload?.customer_id &&
              r.content_fingerprint === insertPayload?.content_fingerprint,
          );
          if (dup) return { data: null, error: { code: "23505" } };
          const newRow = { id: `row-${rows.length + 1}`, ...insertPayload };
          rows.push(newRow);
          return { data: newRow, error: null };
        }
        let matched = rows.filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        if (orderCol) {
          matched = [...matched].sort((a, b) =>
            String(b[orderCol as string]).localeCompare(
              String(a[orderCol as string]),
            ),
          );
        }
        if (limitN) matched = matched.slice(0, limitN);
        return { data: matched[0] ?? null, error: null };
      },
      async single() {
        return this.maybeSingle();
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        const matched = rows.filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
        return Promise.resolve({ data: matched, error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };
    return builder;
  }
  return { from } as unknown as AppSupabaseClient;
}

describe("hydrateCustomerCrmBaseline", () => {
  it("throws CustomerNotVisibleError when the caller's own client can't see the customer (RLS)", async () => {
    const caller = fakeSupabase({ customers: [] });
    const service = fakeSupabase({});
    await expect(
      hydrateCustomerCrmBaseline(
        caller,
        service,
        { crmBaseUrl: "https://crm.example.test", crmApiKey: null },
        "cust-1",
      ),
    ).rejects.toBeInstanceOf(CustomerNotVisibleError);
  });

  it("throws CustomerHasNoExternalIdentityError when external_applywizz_id is null", async () => {
    const caller = fakeSupabase({
      customers: [
        { id: "cust-1", organization_id: "org-1", external_applywizz_id: null },
      ],
    });
    const service = fakeSupabase({});
    await expect(
      hydrateCustomerCrmBaseline(
        caller,
        service,
        { crmBaseUrl: "https://crm.example.test", crmApiKey: null },
        "cust-1",
      ),
    ).rejects.toBeInstanceOf(CustomerHasNoExternalIdentityError);
  });

  it("never lets the caller supply an arbitrary AWL id — always reads it from the customer row", async () => {
    const caller = fakeSupabase({
      customers: [
        {
          id: "cust-1",
          organization_id: "org-1",
          external_applywizz_id: "AWL-00000",
        },
      ],
    });
    const service = fakeSupabase({ customer_context_snapshots: [] });
    vi.mocked(getCustomerDetails).mockResolvedValue({
      normalized: {
        truthFields: {
          target_roles: ["Backend Engineer"],
          alternate_roles: null,
          locations: null,
          compensation: null,
          work_authorization: null,
          sponsorship: null,
          relocation: null,
          work_mode: null,
          avoid_companies: null,
        },
        context: {
          resume_url: null,
          service_start: null,
          service_end: null,
          application_count: null,
          experience: null,
          education_context: null,
          upstream_role_updated_at: null,
          onboarding_form_submitted_at: null,
        },
      },
      sourceUpdatedAt: null,
    });

    await hydrateCustomerCrmBaseline(
      caller,
      service,
      { crmBaseUrl: "https://crm.example.test", crmApiKey: null },
      "cust-1",
    );

    expect(getCustomerDetails).toHaveBeenCalledWith(
      "https://crm.example.test",
      "AWL-00000",
      null,
    );
  });

  it("is idempotent — an identical refetch does not create a duplicate snapshot", async () => {
    const caller = fakeSupabase({
      customers: [
        {
          id: "cust-1",
          organization_id: "org-1",
          external_applywizz_id: "AWL-00000",
        },
      ],
    });
    const service = fakeSupabase({ customer_context_snapshots: [] });
    const normalized = {
      truthFields: {
        target_roles: ["Backend Engineer"],
        alternate_roles: null,
        locations: null,
        compensation: null,
        work_authorization: null,
        sponsorship: null,
        relocation: null,
        work_mode: null,
        avoid_companies: null,
      },
      context: {
        resume_url: null,
        service_start: null,
        service_end: null,
        application_count: null,
        experience: null,
        education_context: null,
        upstream_role_updated_at: null,
        onboarding_form_submitted_at: null,
      },
    };
    vi.mocked(getCustomerDetails).mockResolvedValue({
      normalized,
      sourceUpdatedAt: null,
    });

    const first = await hydrateCustomerCrmBaseline(
      caller,
      service,
      { crmBaseUrl: "https://crm.example.test", crmApiKey: null },
      "cust-1",
    );
    const second = await hydrateCustomerCrmBaseline(
      caller,
      service,
      { crmBaseUrl: "https://crm.example.test", crmApiKey: null },
      "cust-1",
    );

    expect(first.hydrated).toBe(true);
    expect(second.hydrated).toBe(false);
  });
});

describe("getEffectiveCustomerTruth", () => {
  it("prefers confirmed Signal truth over the CRM baseline for the same field", async () => {
    const supabase = fakeSupabase({
      customer_truth_current: [
        {
          customer_id: "cust-1",
          field_key: "target_roles",
          value: ["Python Backend"],
        },
      ],
      customer_context_snapshots: [
        {
          customer_id: "cust-1",
          created_at: "2026-09-01T00:00:00Z",
          normalized_data: {
            truthFields: { target_roles: ["Java Backend"] },
          },
        },
      ],
    });

    const result = await getEffectiveCustomerTruth(supabase, "cust-1");
    const targetRoles = result.find((r) => r.fieldKey === "target_roles");
    expect(targetRoles?.provenance).toBe("signal_confirmed");
    expect(targetRoles?.currentValue).toEqual(["Python Backend"]);
    expect(targetRoles?.crmBaseline).toEqual(["Java Backend"]);
  });

  it("falls back to the CRM baseline when there is no confirmed Signal fact", async () => {
    const supabase = fakeSupabase({
      customer_truth_current: [],
      customer_context_snapshots: [
        {
          customer_id: "cust-1",
          created_at: "2026-09-01T00:00:00Z",
          normalized_data: {
            truthFields: { locations: ["Austin", "Dallas"] },
          },
        },
      ],
    });

    const result = await getEffectiveCustomerTruth(supabase, "cust-1");
    const locations = result.find((r) => r.fieldKey === "locations");
    expect(locations?.provenance).toBe("crm_baseline");
    expect(locations?.currentValue).toEqual(["Austin", "Dallas"]);
  });

  it("reports 'none' when neither a confirmed fact nor a CRM baseline value exists", async () => {
    const supabase = fakeSupabase({
      customer_truth_current: [],
      customer_context_snapshots: [],
    });
    const result = await getEffectiveCustomerTruth(supabase, "cust-1");
    expect(result.every((r) => r.provenance === "none")).toBe(true);
  });
});

describe("isSemanticallySameValue", () => {
  it("treats reordered arrays with different casing/whitespace as the same", () => {
    expect(
      isSemanticallySameValue([" Austin ", "Dallas"], ["dallas", "austin"]),
    ).toBe(true);
  });

  it("treats a genuinely different array as different", () => {
    expect(isSemanticallySameValue(["Austin"], ["Boston"])).toBe(false);
  });

  it("treats null and undefined as the same absence of a value", () => {
    expect(isSemanticallySameValue(null, undefined)).toBe(true);
  });

  it("compares strings case/whitespace-insensitively", () => {
    expect(isSemanticallySameValue("  Remote ", "remote")).toBe(true);
  });
});
