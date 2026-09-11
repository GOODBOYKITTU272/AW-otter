import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
  getPortfolioOverview,
  type PortfolioCustomerRow,
} from "@applywizz/domain/am-portfolio";

const ATTENTION_TONE: Record<string, BadgeTone> = {
  high: "critical",
  medium: "warning",
};

function attentionLabel(row: PortfolioCustomerRow) {
  if (row.attention.level === "high") return "High attention";
  if (row.attention.level === "medium") return "Medium attention";
  return null;
}

// M14: team portfolio, grouped by AM. Same getPortfolioOverview call as
// /manager/overview (frozen — do not change) — this page just presents
// the identical, RLS-scoped data grouped by owner instead of as a flat
// needs-attention list, so a manager can drill AM -> customer. No new
// authorization, no new attention rules.
export default async function ManagerTeamPage() {
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

  const byOwner = new Map<string, PortfolioCustomerRow[]>();
  for (const row of portfolio) {
    const list = byOwner.get(row.ownerMembershipId) ?? [];
    list.push(row);
    byOwner.set(row.ownerMembershipId, list);
  }
  const owners = Array.from(byOwner.entries())
    .map(([ownerId, customers]) => ({
      ownerId,
      name: ownerNameById.get(ownerId) ?? "Unassigned",
      customers: customers.sort((a, b) =>
        a.attention.level === b.attention.level
          ? 0
          : a.attention.level === "high"
            ? -1
            : b.attention.level === "high"
              ? 1
              : a.attention.level === "medium"
                ? -1
                : 1,
      ),
      highCount: customers.filter((c) => c.attention.level === "high").length,
      mediumCount: customers.filter((c) => c.attention.level === "medium")
        .length,
      pendingTruthCount: customers.reduce(
        (sum, c) => sum + c.pendingTruthCount,
        0,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const pendingReview = portfolio.filter((c) => c.pendingTruthCount > 0);

  return (
    <main className="flex flex-1 flex-col">
      <header className="border-b border-[#F5F5F5]/10 bg-[#1E1E1E] px-8 py-4">
        <div className="flex items-center justify-between">
          <Link href="/manager/overview" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <div className="h-8 w-8 rounded-lg bg-[#29FE29] flex items-center justify-center">
              <span className="text-sm font-bold text-[#1E1E1E]">AW</span>
            </div>
            <span className="text-base font-bold tracking-tight text-white">
              Apply Wizz Echo
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-[#F5F5F5]/90">
              {membership.displayName} <span className="text-[#F5F5F5]/50">· Manager</span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-6 p-8">
        <h1 className="text-xl font-semibold tracking-tight">Team portfolio</h1>

      {pendingReview.length > 0 ? (
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <h2 className="text-sm font-medium">
              Pending customer truth changes awaiting review
            </h2>
          </div>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {pendingReview.map((c) => (
              <li
                key={c.customerId}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <Link
                  href={`/customers/${c.customerId}`}
                  className="font-medium hover:underline"
                >
                  {c.name}
                </Link>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {ownerNameById.get(c.ownerMembershipId) ?? "Unassigned"} ·{" "}
                  {c.pendingTruthCount} pending change
                  {c.pendingTruthCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col gap-6">
        {owners.map((owner) => (
          <section
            key={owner.ownerId}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-medium">{owner.name}</h2>
              <div className="flex gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                <span>{owner.customers.length} customers</span>
                {owner.highCount > 0 ? (
                  <span className="text-red-600 dark:text-red-400">
                    {owner.highCount} high
                  </span>
                ) : null}
                {owner.mediumCount > 0 ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {owner.mediumCount} medium
                  </span>
                ) : null}
              </div>
            </div>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {owner.customers.map((c) => {
                const label = attentionLabel(c);
                return (
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
                      {label ? (
                        <StatusBadge
                          tone={ATTENTION_TONE[c.attention.level] ?? "neutral"}
                        >
                          {label}
                        </StatusBadge>
                      ) : null}
                    </div>
                    {c.attention.reasons.length > 0 ? (
                      <ul className="ml-4 list-disc text-xs text-zinc-500 dark:text-zinc-400">
                        {c.attention.reasons.map((r) => (
                          <li key={r.code}>{r.label}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-zinc-400 dark:text-zinc-600">
                        Nothing needs attention.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

        <div className="flex gap-4">
          <Link href="/manager/overview" className="w-fit text-sm underline">
            Manager overview
          </Link>
          <Link href="/actions" className="w-fit text-sm underline">
            Actions
          </Link>
          <Link href="/manager/meetings" className="w-fit text-sm underline">
            Meetings
          </Link>
        </div>
      </div>
    </main>
  );
}
