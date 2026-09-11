import type { AppSupabaseClient } from "./ask-signal";

export interface Row {
  [key: string]: unknown;
}

export function fakeLiveSupabase(tables: Record<string, Row[]>) {
  const auditEvents: Array<{ action: string; metadata: Record<string, unknown> }> = [];

  function from(table: string) {
    const rows = tables[table] ?? [];
    let filtered = [...rows];
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;

    const builder = {
      select() {
        return builder;
      },
      eq(col: string, value: unknown) {
        filtered = filtered.filter((r) => r[col] === value);
        return builder;
      },
      in(col: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[col]));
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderCol = col;
        ascending = opts?.ascending ?? true;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      insert(payload: Record<string, unknown>) {
        if (table === "audit_events") {
          auditEvents.push(payload as { action: string; metadata: Record<string, unknown> });
          return Promise.resolve({ error: null });
        }
        if (table === "customer_truth_facts") {
          // Check RLS rule: authenticated cannot insert confirmed meeting facts directly
          if (payload["status"] === "confirmed" && payload["source_type"] === "meeting") {
            const rlsError = new Error("new row violates row-level security policy for table customer_truth_facts");
            (rlsError as unknown as { code: string }).code = "42501";
            return {
              select: () => ({
                single: async () => ({ data: null, error: rlsError }),
              }),
            };
          }
          const created = { id: `fact-${Date.now()}-${rows.length + 1}`, ...payload };
          rows.push(created);
          return {
            select: () => ({
              single: async () => ({ data: created, error: null }),
              maybeSingle: async () => ({ data: created, error: null }),
            }),
          };
        }
        return Promise.resolve({ error: null });
      },
      async maybeSingle() {
        const result = apply();
        return { data: result[0] ?? null, error: null };
      },
      then(
        onFulfilled: (v: { data: unknown; error: unknown }) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) {
        return Promise.resolve({ data: apply(), error: null }).then(
          onFulfilled,
          onRejected,
        );
      },
    };

    function apply() {
      let result = filtered;
      if (orderCol) {
        const col = orderCol;
        result = [...result].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN) result = result.slice(0, limitN);
      return result;
    }

    return builder;
  }

  return { client: { from } as unknown as AppSupabaseClient, auditEvents, tables };
}
