import Link from "next/link";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPortfolioOverview,
  calendarDayOffset,
  type PortfolioCustomerRow,
} from "@applywizz/domain/am-portfolio";

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other / Unknown",
};

const ATTENTION_TONE: Record<string, BadgeTone> = {
  high: "critical",
  medium: "warning",
  normal: "neutral",
};

type FilterKey =
  | "needs_attention"
  | "call_today"
  | "call_this_week"
  | "overdue"
  | "pending_truth"
  | "renewal_soon"
  | "blocker"
  | "no_upcoming_call";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "needs_attention", label: "Needs attention" },
  { key: "call_today", label: "Call today" },
  { key: "call_this_week", label: "Call this week" },
  { key: "overdue", label: "Overdue action" },
  { key: "pending_truth", label: "Pending truth change" },
  { key: "renewal_soon", label: "Renewal soon" },
  { key: "blocker", label: "Blocker open" },
  { key: "no_upcoming_call", label: "No upcoming call" },
];

function callTypeLabel(callType: string | null) {
  if (!callType) return "—";
  return CALL_TYPE_LABEL[callType] ?? callType;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function matchesFilter(
  row: PortfolioCustomerRow,
  filter: FilterKey | null,
  now: Date,
  timezone: string,
): boolean {
  if (!filter) return true;
  switch (filter) {
    case "needs_attention":
      return row.attention.level !== "normal";
    case "call_today":
      return row.isCallToday;
    case "call_this_week":
      // Calendar-day math (Codex-independent self-review finding, folded
      // into the M11/M12 "today vs in 1 day" fix): a raw millisecond
      // comparison here disagreed with the attention engine's own
      // call_soon window and could show a customer here when the
      // Needs-Attention section (calendar-day-based) already moved past
      // it, or vice versa.
      return Boolean(
        row.nextCall &&
        calendarDayOffset(timezone, now, new Date(row.nextCall.scheduledAt)) <=
          7,
      );
    case "overdue":
      return row.overdueActionCount > 0;
    case "pending_truth":
      return row.pendingTruthCount > 0;
    case "renewal_soon":
      // Codex-independent-review SHOULD-FIX (fixed): this used to
      // re-derive the day count from `row.serviceEnd` itself, a second
      // computation site alongside `getPortfolioOverview`'s own —
      // `serviceEndDaysAway` is now the ONLY place this is computed
      // (single source of truth), matching the fix already applied to
      // /home's Upcoming Renewals section.
      return (
        row.serviceEndDaysAway !== null &&
        row.serviceEndDaysAway >= 0 &&
        row.serviceEndDaysAway <= 30
      );
    case "blocker":
      return row.openBlockerCount > 0;
    case "no_upcoming_call":
      return !row.nextCall;
  }
}

// M12: the real AM operational portfolio view — evolved from M10's bare
// name/lifecycle/pending-count table. RLS scopes every row to whatever the
// signed-in user (own/manager-in-tree/admin) can see; this page never
// re-derives that.
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const membership = await requireRole([
    "account_manager",
    "manager",
    "senior_manager",
    "admin",
  ]);
  const supabase = await getSupabaseServerClient();
  const { filter, q } = await searchParams;
  const activeFilter = FILTERS.find((f) => f.key === filter)?.key ?? null;

  const [portfolio, org] = await Promise.all([
    getPortfolioOverview(supabase, membership.organizationId),
    supabase
      .from("organizations")
      .select("timezone")
      .eq("id", membership.organizationId)
      .maybeSingle(),
  ]);
  if (org.error) throw org.error;
  const timezone = org.data?.timezone ?? "UTC";
  const now = new Date();

  const searchTerm = q?.trim().toLowerCase() ?? "";
  const rows = portfolio
    .filter((row) => matchesFilter(row, activeFilter, now, timezone))
    .filter(
      (row) => !searchTerm || row.name.toLowerCase().includes(searchTerm),
    );

  return (
    <div className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Customers</h1>

      <form className="flex gap-2" action="/customers">
        {activeFilter ? (
          <input type="hidden" name="filter" value={activeFilter} />
        ) : null}
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search customers…"
          className="w-64 rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
        >
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        <Link
          href={q ? `/customers?q=${encodeURIComponent(q)}` : "/customers"}
          className={`rounded-full border px-3 py-1 text-xs ${
            !activeFilter
              ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
              : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
          }`}
        >
          All ({portfolio.length})
        </Link>
        {FILTERS.map((f) => {
          const count = portfolio.filter((row) =>
            matchesFilter(row, f.key, now, timezone),
          ).length;
          const href = `/customers?filter=${f.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
          return (
            <Link
              key={f.key}
              href={href}
              className={`rounded-full border px-3 py-1 text-xs ${
                activeFilter === f.key
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-50 dark:bg-zinc-50 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
              }`}
            >
              {f.label} ({count})
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {portfolio.length === 0
            ? "No customers yet."
            : "No customers match this filter."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Lifecycle</th>
                <th className="px-4 py-2 font-medium">Next call</th>
                <th className="px-4 py-2 font-medium">Last call</th>
                <th className="px-4 py-2 font-medium">Open</th>
                <th className="px-4 py-2 font-medium">Overdue</th>
                <th className="px-4 py-2 font-medium">Pending truth</th>
                <th className="px-4 py-2 font-medium">Blockers</th>
                <th className="px-4 py-2 font-medium">Service end</th>
                <th className="px-4 py-2 font-medium">Attention</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {rows.map((row) => (
                <tr key={row.customerId}>
                  <td className="px-4 py-3">
                    <Link
                      href={`/customers/${row.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {row.lifecycleStage ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {row.nextCall
                      ? `${callTypeLabel(row.nextCall.callType)} · ${formatDate(row.nextCall.scheduledAt)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {row.lastCall
                      ? `${callTypeLabel(row.lastCall.callType)} · ${formatDate(row.lastCall.scheduledAt)}`
                      : "—"}
                  </td>
                  <td className="px-4 py-3">{row.openActionCount}</td>
                  <td className="px-4 py-3">
                    {row.overdueActionCount > 0 ? (
                      <StatusBadge tone="critical">
                        {row.overdueActionCount}
                      </StatusBadge>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.pendingTruthCount > 0 ? (
                      <StatusBadge tone="warning">
                        {row.pendingTruthCount}
                      </StatusBadge>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.openBlockerCount > 0 ? (
                      <StatusBadge tone="critical">
                        {row.openBlockerCount}
                      </StatusBadge>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {formatDate(row.serviceEnd)}
                  </td>
                  <td className="px-4 py-3">
                    {row.attention.level === "normal" ? (
                      <span className="text-zinc-400">Normal</span>
                    ) : (
                      <StatusBadge
                        tone={ATTENTION_TONE[row.attention.level] ?? "neutral"}
                      >
                        {row.attention.level === "high" ? "High" : "Medium"}
                      </StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
