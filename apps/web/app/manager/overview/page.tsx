import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioOverview } from "@applywizz/domain/am-portfolio";

const ATTENTION_TONE: Record<string, BadgeTone> = {
  high: "critical",
  medium: "warning",
};

// M14 vertical slice: reuses M12's portfolio/attention engine verbatim —
// getPortfolioOverview's customer query has no owner filter of its own,
// so RLS alone (customers_select_manager_scope: intelligence.read +
// is_manager_of) already scopes the result to this manager's reporting
// tree, the same way customers_select_own scopes it to a single AM. No
// new authorization logic, no new attention rules — same deterministic,
// evidence-based reasons as /home, just rolled up across the team.
export default async function ManagerOverviewPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();

  const portfolio = await getPortfolioOverview(
    supabase,
    membership.organizationId,
  );

  const ownerIds = Array.from(
    new Set(portfolio.map((c) => c.ownerMembershipId)),
  );
  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: owners, error: ownersError } = await supabase
      .from("organization_memberships")
      .select("id, display_name")
      .in("id", ownerIds);
    if (ownersError) throw ownersError;
    for (const o of owners ?? []) ownerNameById.set(o.id, o.display_name);
  }

  const needsAttention = portfolio
    .filter((c) => c.attention.level !== "normal")
    .sort((a, b) =>
      a.attention.level === b.attention.level
        ? 0
        : a.attention.level === "high"
          ? -1
          : 1,
    );
  const highCount = portfolio.filter(
    (c) => c.attention.level === "high",
  ).length;
  const mediumCount = portfolio.filter(
    (c) => c.attention.level === "medium",
  ).length;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">
          Manager overview
        </h1>
        <SignOutButton />
      </div>
      <p className="-mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        Signed in as {membership.displayName}.
      </p>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-2xl font-semibold">{portfolio.length}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Customers on your team
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-2xl font-semibold text-red-600 dark:text-red-400">
            {highCount}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            High attention
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
            {mediumCount}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Medium attention
          </p>
        </div>
      </div>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">
            What your team needs attention on
          </h2>
        </div>
        {needsAttention.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Nothing needs attention across your team right now.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {needsAttention.map((c) => (
              <li
                key={c.customerId}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/customers/${c.customerId}`}
                    className="font-medium hover:underline"
                  >
                    {c.name}
                  </Link>
                  <StatusBadge
                    tone={ATTENTION_TONE[c.attention.level] ?? "neutral"}
                  >
                    {c.attention.level === "high"
                      ? "High attention"
                      : "Medium attention"}
                  </StatusBadge>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {ownerNameById.get(c.ownerMembershipId) ?? "Unassigned"}
                  </span>
                </div>
                <ul className="ml-4 list-disc text-xs text-zinc-500 dark:text-zinc-400">
                  {c.attention.reasons.map((r) => (
                    <li key={r.code}>{r.label}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex gap-4">
        <Link href="/integrations" className="w-fit text-sm underline">
          Integrations
        </Link>
        <Link href="/manager/exceptions" className="w-fit text-sm underline">
          Do-Not-Record Exceptions
        </Link>
      </div>
    </main>
  );
}
