import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { ResolveAction } from "@/components/actions/resolve-action";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { listRecentMeetingSummaries } from "@applywizz/domain/meeting-recap";
import {
  getPortfolioOverview,
  getPortfolioActionQueue,
  relativeDayLabel,
} from "@applywizz/domain/am-portfolio";

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other / Unknown",
};

const RECORD_TYPE_LABELS: Record<string, string> = {
  action_item: "Action",
  commitment: "Commitment",
  decision: "Decision",
  question: "Question",
  blocker: "Blocker",
};

const ATTENTION_TONE: Record<string, BadgeTone> = {
  high: "critical",
  medium: "warning",
};

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function callTypeLabel(callType: string | null) {
  if (!callType) return "Call";
  return CALL_TYPE_LABEL[callType] ?? callType;
}

// M12: the real AM daily operating home. RLS alone scopes every query to
// this AM's own portfolio (owner_membership_id = current_membership_id())
// — same convention established in M9-M11, no explicit filter needed since
// this route is account_manager-only.
export default async function AccountManagerHomePage() {
  const membership = await requireRole(["account_manager"]);
  const supabase = await getSupabaseServerClient();

  const nowDate = new Date();

  const [portfolio, org, recentMeetings] = await Promise.all([
    getPortfolioOverview(supabase, membership.organizationId),
    supabase
      .from("organizations")
      .select("timezone")
      .eq("id", membership.organizationId)
      .maybeSingle(),
    listRecentMeetingSummaries(supabase, { limit: 5 }),
  ]);
  if (org.error) throw org.error;
  const timezone = org.data?.timezone ?? "UTC";

  // Independently-capped queries for overdue vs. due-today-or-soon —
  // Codex-independent-review fix: a single shared cap let a large overdue
  // backlog push genuinely near-term items out of view entirely (see
  // getPortfolioActionQueue's own doc comment for the full story).
  const actionQueue = await getPortfolioActionQueue(
    supabase,
    timezone,
    nowDate,
  );

  // --- Today's Calls (§A.1) ---
  const todaysCalls = portfolio
    .flatMap((c) => c.todaysCalls.map((call) => ({ customer: c, call })))
    .sort((a, b) => a.call.scheduledAt.localeCompare(b.call.scheduledAt));

  // --- Needs Your Attention (§A.2) — real, explainable, sorted high first ---
  const needsAttention = portfolio
    .filter((c) => c.attention.level !== "normal")
    .sort((a, b) =>
      a.attention.level === b.attention.level
        ? 0
        : a.attention.level === "high"
          ? -1
          : 1,
    );

  // --- Overdue / Due Soon (§A.3) ---
  const overdueRecords = actionQueue.overdue;
  const dueTodayRecords = actionQueue.dueToday;
  const dueSoonRecords = actionQueue.dueSoon;
  const dueSoonCustomerIds = Array.from(
    new Set(
      [...overdueRecords, ...dueTodayRecords, ...dueSoonRecords]
        .map((r) => r.customerId)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const customerNameById = new Map(
    portfolio.map((c) => [c.customerId, c.name]),
  );
  if (dueSoonCustomerIds.some((id) => !customerNameById.has(id))) {
    const missing = dueSoonCustomerIds.filter(
      (id) => !customerNameById.has(id),
    );
    const { data: extra, error: extraError } = await supabase
      .from("customers")
      .select("id, name")
      .in("id", missing);
    if (extraError) throw extraError;
    for (const c of extra ?? []) customerNameById.set(c.id, c.name);
  }

  // --- Recent Changes (§A.4) ---
  const [recentConfirmed, recentCompleted] = await Promise.all([
    supabase
      .from("customer_truth_facts")
      .select("customer_id, field_key, value, confirmed_at")
      .eq("status", "confirmed")
      .order("confirmed_at", { ascending: false })
      .limit(8),
    supabase
      .from("call_records")
      .select("customer_id, description, completed_at")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(8),
  ]);
  if (recentConfirmed.error) throw recentConfirmed.error;
  if (recentCompleted.error) throw recentCompleted.error;
  const recentChanges = [
    ...(recentConfirmed.data ?? []).map((f) => ({
      key: `truth-${f.customer_id}-${f.field_key}-${f.confirmed_at}`,
      customerId: f.customer_id,
      at: f.confirmed_at as string,
      text: `${f.field_key.replaceAll("_", " ")} confirmed: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`,
    })),
    ...(recentCompleted.data ?? []).map((r) => ({
      key: `record-${r.customer_id}-${r.description}-${r.completed_at}`,
      customerId: r.customer_id,
      at: r.completed_at as string,
      text: `Completed: ${r.description}`,
    })),
  ]
    .filter((c) => c.at)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  // --- Upcoming Renewals (§A.5) ---
  // Codex-independent-review fix: this used to pre-filter on a raw
  // UTC date-string compare (`serviceEnd >= nowIso.slice(0,10)`) BEFORE
  // ever running the org-timezone-aware `calendarDayOffset` check — for a
  // negative-UTC-offset org near midnight, that raw compare could discard
  // a same-day/near-term renewal before the real check ever saw it, the
  // exact bug class this file's `calendarDayOffset` comment describes.
  // `serviceEndDaysAway` is now computed ONCE, correctly, inside
  // `getPortfolioOverview` itself (single source of truth) — this page no
  // longer re-derives it, and there is no raw date-string filter left.
  const upcomingRenewals = portfolio
    .filter(
      (c) =>
        c.serviceEndDaysAway !== null &&
        c.serviceEndDaysAway >= 0 &&
        c.serviceEndDaysAway <= 30,
    )
    .map((c) => ({ customer: c, daysAway: c.serviceEndDaysAway! }))
    .sort((a, b) => a.daysAway - b.daysAway);

  const nextCall = todaysCalls[0] ?? null;
  let nextCallRemembers: string[] = [];
  if (nextCall) {
    const [topFacts, topActions] = await Promise.all([
      supabase
        .from("customer_truth_facts")
        .select("field_key, value")
        .eq("customer_id", nextCall.customer.customerId)
        .eq("status", "confirmed")
        .limit(3),
      supabase
        .from("call_records")
        .select("description")
        .eq("customer_id", nextCall.customer.customerId)
        .eq("status", "detected")
        .limit(2),
    ]);
    nextCallRemembers = [
      ...(topFacts.data ?? []).map(
        (f) =>
          `${f.field_key.replaceAll("_", " ")}: ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)}`,
      ),
      ...(topActions.data ?? []).map((a) => `Commitment: ${a.description}`),
    ];
  }

  const firstName = membership.displayName.split(" ")[0] ?? membership.displayName;

  return (
    <main className="flex flex-1 flex-col bg-[#EFFBFF]">
      <header className="border-b border-[#1E1E1E]/10 bg-white px-8 py-4 shadow-sm">
        <div className="flex items-center justify-between max-w-5xl mx-auto w-full">
          <Link href="/home" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <div className="h-8 w-8 rounded-lg bg-[#29FE29] flex items-center justify-center">
              <span className="text-sm font-bold text-[#1E1E1E]">AW</span>
            </div>
            <span className="text-base font-bold tracking-tight text-[#1E1E1E]">
              Apply Wizz Echo
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="text-sm text-[#1E1E1E]/90">
              {membership.displayName} <span className="text-[#1E1E1E]/50">· Account Manager</span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-6 p-8 max-w-5xl mx-auto w-full">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight text-[#1E1E1E]">
            Good morning, {firstName}
          </h1>
          <p className="text-sm font-medium text-[#1E1E1E]/70">
            <span className="font-semibold text-[#2C76FF]">
              {todaysCalls.length}
            </span>{" "}
            call{todaysCalls.length === 1 ? "" : "s"} today ·{" "}
            <span className="font-semibold text-[#FFDE59]">
              {needsAttention.length}
            </span>{" "}
            thing{needsAttention.length === 1 ? "" : "s"} need your attention
          </p>
        </div>

      {nextCall ? (
        <section className="rounded-xl border border-[#2C76FF]/20 bg-gradient-to-br from-[#2C76FF]/10 to-[#29FE29]/5 p-6 shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-[#2C76FF]">
              Next Call
            </span>
            <span className="rounded-full bg-[#2C76FF] px-3 py-1 text-xs font-semibold text-white">
              {formatTime(nextCall.call.scheduledAt)}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <Link
                href={`/customers/${nextCall.customer.customerId}`}
                className="text-xl font-bold text-[#1E1E1E] hover:underline"
              >
                {nextCall.customer.name}
              </Link>
              <span className="ml-2 text-sm text-[#1E1E1E]/60">
                · {callTypeLabel(nextCall.call.callType)}
              </span>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-[#2C76FF]/20 bg-white p-4 text-sm">
            <span className="font-semibold text-[#1E1E1E]">
              Echo remembers:
            </span>
            {nextCallRemembers.length > 0 ? (
              <ul className="mt-2 list-inside list-disc space-y-1 text-[#1E1E1E]/80">
                {nextCallRemembers.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[#1E1E1E]/60">
                No prior flags recorded. Echo is ready to capture this call.
              </p>
            )}
          </div>

          <div className="mt-5 flex items-center gap-3">
            {nextCall.call.meetingId ? (
              <Link
                href={`/meetings/${nextCall.call.meetingId}/prep`}
                className="rounded-lg bg-[#29FE29] px-4 py-2 text-sm font-semibold text-[#1E1E1E] shadow-md hover:bg-[#29FE29]/90 transition-all"
              >
                Prepare call
              </Link>
            ) : null}
            <Link
              href={`/customers/${nextCall.customer.customerId}`}
              className="rounded-lg border border-[#1E1E1E]/20 bg-white px-4 py-2 text-sm font-semibold text-[#1E1E1E] hover:bg-[#F5F5F5] transition-all"
            >
              Open customer →
            </Link>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Needs your attention</h2>
        </div>
        {needsAttention.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">
            Nothing needs attention right now.
          </p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {needsAttention.map((c) => (
              <li
                key={c.customerId}
                className="flex flex-col gap-1 px-5 py-4 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/customers/${c.customerId}`}
                    className="font-medium text-[#1E1E1E] hover:underline"
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
                </div>
                <ul className="ml-4 list-disc text-xs text-[#1E1E1E]/70">
                  {c.attention.reasons.map((r) => (
                    <li key={r.code}>{r.label}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Today&apos;s calls</h2>
        </div>
        {todaysCalls.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">
            No customer calls scheduled today.
          </p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {todaysCalls.map(({ customer, call }) => (
              <li
                key={`${customer.customerId}-${call.scheduledAt}`}
                className="flex items-start justify-between gap-3 px-5 py-4 text-sm"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-[#1E1E1E]">
                      {formatTime(call.scheduledAt)}
                    </span>
                    <span className="text-[#1E1E1E]/40">·</span>
                    <Link
                      href={`/customers/${customer.customerId}`}
                      className="font-medium text-[#2C76FF] hover:underline"
                    >
                      {customer.name}
                    </Link>
                    <StatusBadge tone="info">
                      {callTypeLabel(call.callType)}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-[#1E1E1E]/70">
                    {customer.openActionCount} open action{customer.openActionCount === 1 ? "" : "s"} ·{" "}
                    {customer.pendingTruthCount} pending update{customer.pendingTruthCount === 1 ? "" : "s"}
                  </p>
                </div>
                {call.meetingId ? (
                  <Link
                    href={`/meetings/${call.meetingId}`}
                    className="rounded-lg border border-[#2C76FF]/30 bg-[#2C76FF]/10 px-3 py-1.5 text-xs font-medium text-[#2C76FF] hover:bg-[#2C76FF]/20 transition-all"
                  >
                    View meeting →
                  </Link>
                ) : (
                  <span className="text-xs text-[#1E1E1E]/40">Scheduled</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="flex items-center justify-between border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Overdue / due soon</h2>
          <Link
            href="/actions"
            className="text-sm text-[#2C76FF] hover:underline"
          >
            View all
          </Link>
        </div>
        {overdueRecords.length === 0 &&
        dueTodayRecords.length === 0 &&
        dueSoonRecords.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">No overdue actions.</p>
        ) : (
          <div className="divide-y divide-[#1E1E1E]/10">
            {[
              {
                label: "Overdue",
                tone: "critical" as const,
                rows: overdueRecords,
              },
              {
                label: "Due today",
                tone: "warning" as const,
                rows: dueTodayRecords,
              },
              {
                label: "Due within 7 days",
                tone: "neutral" as const,
                rows: dueSoonRecords,
              },
            ]
              .filter((bucket) => bucket.rows.length > 0)
              .map((bucket) => (
                <div key={bucket.label} className="px-5 py-4">
                  <p className="mb-3 text-xs font-medium text-[#1E1E1E]/70 uppercase tracking-wider">
                    {bucket.label}
                  </p>
                  <ul className="flex flex-col gap-3">
                    {bucket.rows.map((record) => (
                      <li
                        key={record.id}
                        className="flex items-start justify-between gap-3 text-sm"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge tone={bucket.tone}>
                              {RECORD_TYPE_LABELS[record.recordType] ??
                                record.recordType}
                            </StatusBadge>
                            {record.dueAt ? (
                              <span className="text-xs text-[#1E1E1E]/70">
                                Due {formatDate(record.dueAt)}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-[#1E1E1E]">{record.description}</p>
                          <p className="mt-1 text-xs text-[#1E1E1E]/70">
                            {record.customerId
                              ? customerNameById.get(record.customerId)
                              : null}
                          </p>
                        </div>
                        <ResolveAction recordId={record.id} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Recent changes</h2>
        </div>
        {recentChanges.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">No recent changes.</p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {recentChanges.map((change) => (
              <li
                key={change.key}
                className="flex flex-col gap-1 px-5 py-4 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {change.customerId ? (
                    <Link
                      href={`/customers/${change.customerId}`}
                      className="font-medium text-[#1E1E1E] hover:underline"
                    >
                      {customerNameById.get(change.customerId) ?? "Customer"}
                    </Link>
                  ) : null}
                  <span className="text-xs text-[#1E1E1E]/70">
                    {formatDate(change.at)}
                  </span>
                </div>
                <p className="text-[#1E1E1E]/80">
                  {change.text}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Upcoming renewals</h2>
        </div>
        {upcomingRenewals.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">
            No upcoming renewals in the next 30 days.
          </p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {upcomingRenewals.map(({ customer, daysAway }) => (
              <li
                key={customer.customerId}
                className="flex items-start justify-between gap-3 px-5 py-4 text-sm"
              >
                <div>
                  <Link
                    href={`/customers/${customer.customerId}`}
                    className="font-medium text-[#1E1E1E] hover:underline"
                  >
                    {customer.name}
                  </Link>
                  <p className="mt-1 text-xs text-[#1E1E1E]/70">
                    Service period ends {relativeDayLabel(daysAway)}
                    {customer.lastCall
                      ? ` · Last call: ${callTypeLabel(customer.lastCall.callType)}`
                      : ""}
                  </p>
                  <p className="mt-1 text-xs text-[#1E1E1E]/70">
                    {customer.openActionCount} open action
                    {customer.openActionCount === 1 ? "" : "s"} ·{" "}
                    {customer.openBlockerCount} blocker
                    {customer.openBlockerCount === 1 ? "" : "s"}
                  </p>
                </div>
                <Link
                  href={`/customers/${customer.customerId}`}
                  className="text-sm text-[#2C76FF] hover:underline"
                >
                  Review customer
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-[#1E1E1E]">Upcoming customer calls</h2>
        <UpcomingMeetings supabase={supabase} showRequestAction />
      </section>

      <section className="rounded-xl border border-[#1E1E1E]/10 bg-white shadow-md">
        <div className="border-b border-[#1E1E1E]/10 px-5 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">Recent conversations</h2>
        </div>
        {recentMeetings.length === 0 ? (
          <p className="px-5 py-6 text-sm text-[#1E1E1E]/60">
            No recent conversations with intelligence ready yet.
          </p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {recentMeetings.map((m) => (
              <li
                key={m.meetingId}
                className="flex flex-col gap-1 px-5 py-4 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/meetings/${m.meetingId}/recap`}
                    className="font-medium text-[#1E1E1E] hover:underline"
                  >
                    {m.customerName ?? "Unlinked meeting"}
                  </Link>
                  {m.callType ? (
                    <StatusBadge tone="info">
                      {callTypeLabel(m.callType)}
                    </StatusBadge>
                  ) : null}
                  <span className="text-xs text-[#1E1E1E]/70">
                    {formatDate(m.scheduledStart)}
                  </span>
                </div>
                {m.summary ? (
                  <p className="text-[#1E1E1E]/80">
                    {m.summary}
                  </p>
                ) : null}
                <p className="text-xs text-[#1E1E1E]/70">
                  {m.truthChangeCount} truth change
                  {m.truthChangeCount === 1 ? "" : "s"} · {m.openActionCount}{" "}
                  action
                  {m.openActionCount === 1 ? "" : "s"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

        <Link href="/integrations" className="w-fit text-sm text-[#2C76FF] hover:underline">
          Integrations
        </Link>
      </div>
    </main>
  );
}
