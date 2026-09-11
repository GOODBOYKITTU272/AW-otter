import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioOverview } from "@applywizz/domain/am-portfolio";

export default async function ManagerOverviewPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();
  const isSenior = membership.roleKey === "senior_manager";

  const portfolio = await getPortfolioOverview(
    supabase,
    membership.organizationId,
  );

  const ownerIds = Array.from(
    new Set(portfolio.map((c) => c.ownerMembershipId)),
  );
  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: owners } = await supabase
      .from("organization_memberships")
      .select("id, display_name")
      .in("id", ownerIds);
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
  // Group attention by AM
  const attentionByAm = new Map<
    string,
    Array<{ customerName: string; customerId: string; level: string; label: string }>
  >();
  for (const c of needsAttention) {
    const amName = ownerNameById.get(c.ownerMembershipId) ?? "Unassigned";
    const existing = attentionByAm.get(amName) ?? [];
    existing.push({
      customerName: c.name,
      customerId: c.customerId,
      level: c.attention.level,
      label: c.attention.reasons[0]?.label ?? "Needs follow-up",
    });
    attentionByAm.set(amName, existing);
  }

  // Calculate Team Pulse
  const teamMeetingsTodayCount = portfolio.reduce(
    (acc, c) => acc + c.todaysCalls.length,
    0,
  );
  const totalOpenActions = portfolio.reduce(
    (acc, c) => acc + c.openActionCount,
    0,
  );
  const totalPendingTruth = portfolio.reduce(
    (acc, c) => acc + c.pendingTruthCount,
    0,
  );

  // Customer Risks: upcoming renewals (<30 days) or blockers
  const customerRisks = portfolio.filter(
    (c) =>
      (c.serviceEndDaysAway !== null && c.serviceEndDaysAway <= 30 && c.serviceEndDaysAway >= 0) ||
      c.openBlockerCount > 0,
  );

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            {isSenior ? "Senior Leadership Pulse" : "Team Pulse"}
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Signed in as {membership.displayName} · {isSenior ? "Senior Manager" : "Manager"}
          </p>
        </div>
        <SignOutButton />
      </div>

      {/* Team Pulse Summary Card */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {teamMeetingsTodayCount}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Team Meetings Today
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {totalPendingTruth}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Reviews Needed
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-red-600 dark:text-red-400">
            {totalOpenActions}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Open Commitments
          </p>
        </div>
      </section>

      {/* Needs Attention by Reporting AM */}
      <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Needs attention across your team
          </h2>
        </div>
        {attentionByAm.size === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            All customer accounts in your reporting line are healthy.
          </p>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {Array.from(attentionByAm.entries()).map(([amName, items]) => (
              <div key={amName} className="p-4 flex flex-col gap-2">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400">
                  {amName} ({items.length} item{items.length === 1 ? "" : "s"})
                </span>
                <ul className="flex flex-col gap-1.5 pl-2">
                  {items.map((item) => (
                    <li
                      key={item.customerId}
                      className="flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/customers/${item.customerId}`}
                          className="font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                        >
                          {item.customerName}
                        </Link>
                        <span className="text-zinc-400">·</span>
                        <span className="text-zinc-600 dark:text-zinc-400">
                          {item.label}
                        </span>
                      </div>
                      <StatusBadge
                        tone={item.level === "high" ? "critical" : "warning"}
                      >
                        {item.level}
                      </StatusBadge>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Customer Risks */}
      <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Customer risks &amp; renewals
          </h2>
        </div>
        {customerRisks.length === 0 ? (
          <p className="p-6 text-sm text-zinc-500">
            No near-term renewal risks or customer blockers detected.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {customerRisks.map((c) => (
              <li
                key={c.customerId}
                className="flex items-center justify-between p-4 text-xs"
              >
                <div>
                  <Link
                    href={`/customers/${c.customerId}`}
                    className="font-semibold text-zinc-900 hover:underline dark:text-zinc-100 text-sm"
                  >
                    {c.name}
                  </Link>
                  <p className="text-zinc-500 mt-0.5">
                    Owner: {ownerNameById.get(c.ownerMembershipId) ?? "Unassigned"}
                    {c.serviceEndDaysAway !== null && c.serviceEndDaysAway <= 30
                      ? ` · Renewal in ${c.serviceEndDaysAway} days`
                      : ""}
                    {c.openBlockerCount > 0 ? ` · ${c.openBlockerCount} blocker` : ""}
                  </p>
                </div>
                <Link
                  href={`/customers/${c.customerId}`}
                  className="rounded-md border border-zinc-200 px-3 py-1.5 font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                >
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Navigation Footer */}
      <div className="flex gap-4 pt-2">
        <Link href="/integrations" className="text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">
          Microsoft Integrations →
        </Link>
        <Link href="/manager/exceptions" className="text-xs font-semibold text-zinc-600 hover:underline dark:text-zinc-400">
          Do-Not-Record Exceptions →
        </Link>
      </div>
    </main>
  );
}
