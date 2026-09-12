import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getPortfolioOverview } from "@applywizz/domain/am-portfolio";
import { getManagerLiveAlerts } from "@applywizz/domain";

export default async function ManagerOverviewPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();
  const isSenior = membership.roleKey === "senior_manager";

  const [portfolio, liveAlerts] = await Promise.all([
    getPortfolioOverview(supabase, membership.organizationId),
    getManagerLiveAlerts(supabase, membership.membershipId),
  ]);

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

  const customerRisks = portfolio.filter(
    (c) =>
      (c.serviceEndDaysAway !== null && c.serviceEndDaysAway <= 30 && c.serviceEndDaysAway >= 0) ||
      c.openBlockerCount > 0,
  );

  return (
    <main className="flex flex-1 flex-col bg-[#0B1D33]">
      <header className="border-b border-[#F5F5F5]/10 bg-[#1E1E1E] px-8 py-4">
        <div className="flex items-center justify-between max-w-6xl mx-auto w-full">
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
              {membership.displayName} <span className="text-[#F5F5F5]/50">· {isSenior ? "Senior Manager" : "Manager"}</span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-6 p-8 max-w-6xl mx-auto w-full">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            {isSenior ? "Senior Leadership Pulse" : "Team Pulse"}
          </h1>
        </div>

      {/* Live Alerts - Phase 1 */}
      {liveAlerts.length > 0 ? (
        <section className="rounded-xl border-2 border-[#FF5C5C] bg-gradient-to-br from-[#FF5C5C]/20 to-[#FFDE59]/10 shadow-xl">
          <div className="border-b-2 border-[#FF5C5C]/30 bg-[#FF5C5C]/10 px-6 py-4">
            <div className="flex items-center gap-2">
              <span className="text-xl">🚨</span>
              <h2 className="text-lg font-bold text-white">
                URGENT: {liveAlerts.length} Team Alert{liveAlerts.length === 1 ? "" : "s"} Require Action
              </h2>
            </div>
          </div>
          <ul className="divide-y divide-[#FF5C5C]/20">
            {liveAlerts.map((alert) => (
              <li key={alert.id} className="px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-[#2C76FF] bg-[#2C76FF]/10 px-2 py-1 rounded">
                        {alert.amName}
                      </span>
                      <StatusBadge tone={alert.severity === "critical" ? "critical" : "warning"}>
                        {alert.alertType === "bot_lobby_stuck" 
                          ? "Bot Stuck in Lobby" 
                          : alert.alertType === "customer_missing_warn"
                            ? "Customer Missing 10min"
                            : "Customer Missing 15min"}
                      </StatusBadge>
                      {alert.occurrenceCount > 1 ? (
                        <span className="text-xs text-white/60">
                          × {alert.occurrenceCount}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium text-white mb-1">
                      {alert.message}
                    </p>
                    <p className="text-xs text-[#F5F5F5]/70">
                      First detected: {new Date(alert.firstSeenAt).toLocaleTimeString()}
                      {alert.lastSeenAt !== alert.firstSeenAt && (
                        <> · Last seen: {new Date(alert.lastSeenAt).toLocaleTimeString()}</>
                      )}
                    </p>
                  </div>
                  <Link
                    href={`/admin/meetings/${alert.meetingId}`}
                    className="rounded-lg bg-[#FF5C5C] px-4 py-2 text-sm font-semibold text-white hover:bg-[#FF5C5C]/90 transition-all shadow-md"
                  >
                    Review →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {isSenior ? (
          <>
            <div className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] p-6 shadow-lg">
              <p className="text-3xl font-bold text-white">
                {portfolio.length}
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Total Accounts
              </p>
            </div>
            <div className="rounded-xl border border-[#2C76FF]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#2C76FF]/10">
              <p className="text-3xl font-bold text-[#2C76FF]">
                {ownerIds.length}
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Reporting AMs
              </p>
            </div>
            <div className="rounded-xl border border-[#29FE29]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#29FE29]/10">
              <p className="text-3xl font-bold text-[#29FE29]">
                {portfolio.length > 0
                  ? Math.round(
                      (portfolio.filter((c) => c.attention.level === "normal").length /
                        portfolio.length) *
                        100,
                    )
                  : 100}
                %
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Portfolio Health
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] p-6 shadow-lg">
              <p className="text-3xl font-bold text-white">
                {teamMeetingsTodayCount}
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Team Meetings Today
              </p>
            </div>
            <div className="rounded-xl border border-[#FFDE59]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#FFDE59]/10">
              <p className="text-3xl font-bold text-[#FFDE59]">
                {totalPendingTruth}
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Reviews Needed
              </p>
            </div>
            <div className="rounded-xl border border-[#FF5C5C]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#FF5C5C]/10">
              <p className="text-3xl font-bold text-[#FF5C5C]">
                {totalOpenActions}
              </p>
              <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
                Open Commitments
              </p>
            </div>
          </>
        )}
      </section>

      <section className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] shadow-lg">
        <div className="border-b border-[#F5F5F5]/10 px-6 py-4">
          <h2 className="text-base font-semibold text-white">
            Needs attention across your team
          </h2>
        </div>
        {attentionByAm.size === 0 ? (
          <p className="p-6 text-sm text-[#F5F5F5]/70">
            All customer accounts in your reporting line are healthy.
          </p>
        ) : (
          <div className="divide-y divide-[#F5F5F5]/10">
            {Array.from(attentionByAm.entries()).map(([amName, items]) => (
              <div key={amName} className="p-5 flex flex-col gap-3">
                <span className="text-xs font-bold uppercase tracking-wider text-[#2C76FF]">
                  {amName} ({items.length} item{items.length === 1 ? "" : "s"})
                </span>
                <ul className="flex flex-col gap-2 pl-2">
                  {items.map((item) => (
                    <li
                      key={item.customerId}
                      className="flex items-center justify-between text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/customers/${item.customerId}`}
                          className="font-medium text-white hover:underline"
                        >
                          {item.customerName}
                        </Link>
                        <span className="text-[#F5F5F5]/40">·</span>
                        <span className="text-[#F5F5F5]/70">
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

      <section className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] shadow-lg">
        <div className="border-b border-[#F5F5F5]/10 px-6 py-4">
          <h2 className="text-base font-semibold text-white">
            Customer risks &amp; renewals
          </h2>
        </div>
        {customerRisks.length === 0 ? (
          <p className="p-6 text-sm text-[#F5F5F5]/70">
            No near-term renewal risks or customer blockers detected.
          </p>
        ) : (
          <ul className="divide-y divide-[#F5F5F5]/10">
            {customerRisks.map((c) => (
              <li
                key={c.customerId}
                className="flex items-center justify-between p-5 text-sm"
              >
                <div>
                  <Link
                    href={`/customers/${c.customerId}`}
                    className="font-semibold text-white hover:underline"
                  >
                    {c.name}
                  </Link>
                  <p className="text-[#F5F5F5]/70 mt-1 text-xs">
                    Owner: {ownerNameById.get(c.ownerMembershipId) ?? "Unassigned"}
                    {c.serviceEndDaysAway !== null && c.serviceEndDaysAway <= 30
                      ? ` · Renewal in ${c.serviceEndDaysAway} days`
                      : ""}
                    {c.openBlockerCount > 0 ? ` · ${c.openBlockerCount} blocker` : ""}
                  </p>
                </div>
                <Link
                  href={`/customers/${c.customerId}`}
                  className="rounded-lg border border-[#2C76FF]/30 bg-[#2C76FF]/10 px-4 py-2 text-xs font-medium text-[#2C76FF] hover:bg-[#2C76FF]/20 transition-all"
                >
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex gap-4 pt-2">
        <Link href="/integrations" className="text-sm font-semibold text-[#2C76FF] hover:underline">
          Microsoft Integrations →
        </Link>
        <Link href="/manager/exceptions" className="text-sm font-semibold text-[#F5F5F5]/70 hover:text-white">
          Do-Not-Record Exceptions →
        </Link>
      </div>
      </div>
    </main>
  );
}
