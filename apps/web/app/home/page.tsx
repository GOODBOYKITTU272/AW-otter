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
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-5xl mx-auto w-full">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Good morning, {firstName}
          </h1>
          <SignOutButton />
        </div>
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          <span className="font-semibold text-blue-600 dark:text-blue-400">
            {todaysCalls.length}
          </span>{" "}
          call{todaysCalls.length === 1 ? "" : "s"} today ·{" "}
          <span className="font-semibold text-amber-600 dark:text-amber-400">
            {needsAttention.length}
          </span>{" "}
          thing{needsAttention.length === 1 ? "" : "s"} need your attention
        </p>
      </div>

      {nextCall ? (
        <section className="rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50/70 to-indigo-50/40 p-5 shadow-sm dark:border-blue-900/50 dark:from-blue-950/40 dark:to-indigo-950/20">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
              Next Call
            </span>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-900/60 dark:text-blue-300">
              {formatTime(nextCall.call.scheduledAt)}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <Link
                href={`/customers/${nextCall.customer.customerId}`}
                className="text-lg font-bold text-zinc-900 hover:underline dark:text-zinc-100"
              >
                {nextCall.customer.name}
              </Link>
              <span className="ml-2 text-xs text-zinc-500">
                · {callTypeLabel(nextCall.call.callType)}
              </span>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-blue-100 bg-white/80 p-3.5 text-xs dark:border-blue-900/40 dark:bg-zinc-900/80">
            <span className="font-semibold text-zinc-700 dark:text-zinc-300">
              Echo remembers:
            </span>
            {nextCallRemembers.length > 0 ? (
              <ul className="mt-1.5 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-300">
                {nextCallRemembers.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-zinc-500 dark:text-zinc-400">
                No prior flags recorded. Echo is ready to capture this call.
              </p>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            {nextCall.call.meetingId ? (
              <Link
                href={`/meetings/${nextCall.call.meetingId}/prep`}
                className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
              >
                Prepare call
              </Link>
            ) : null}
            <Link
              href={`/customers/${nextCall.customer.customerId}`}
              className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            >
              Open customer →
            </Link>
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Needs your attention</h2>
        </div>
        {needsAttention.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Nothing needs attention right now.
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

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Today&apos;s calls</h2>
        </div>
        {todaysCalls.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No customer calls scheduled today.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {todaysCalls.map(({ customer, call }) => (
              <li
                key={`${customer.customerId}-${call.scheduledAt}`}
                className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">
                      {formatTime(call.scheduledAt)}
                    </span>
                    <span className="text-zinc-400">·</span>
                    <Link
                      href={`/customers/${customer.customerId}`}
                      className="font-medium hover:underline text-blue-600 dark:text-blue-400"
                    >
                      {customer.name}
                    </Link>
                    <StatusBadge tone="info">
                      {callTypeLabel(call.callType)}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {customer.openActionCount} open action{customer.openActionCount === 1 ? "" : "s"} ·{" "}
                    {customer.pendingTruthCount} pending update{customer.pendingTruthCount === 1 ? "" : "s"}
                  </p>
                </div>
                {call.meetingId ? (
                  <Link
                    href={`/meetings/${call.meetingId}`}
                    className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
                  >
                    View meeting →
                  </Link>
                ) : (
                  <span className="text-xs text-zinc-400">Scheduled</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Overdue / due soon</h2>
          <Link
            href="/actions"
            className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
          >
            View all
          </Link>
        </div>
        {overdueRecords.length === 0 &&
        dueTodayRecords.length === 0 &&
        dueSoonRecords.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No overdue actions.</p>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
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
                <div key={bucket.label} className="px-4 py-3">
                  <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {bucket.label}
                  </p>
                  <ul className="flex flex-col gap-2">
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
                              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                                Due {formatDate(record.dueAt)}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1">{record.description}</p>
                          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
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

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Recent changes</h2>
        </div>
        {recentChanges.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No recent changes.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {recentChanges.map((change) => (
              <li
                key={change.key}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {change.customerId ? (
                    <Link
                      href={`/customers/${change.customerId}`}
                      className="font-medium hover:underline"
                    >
                      {customerNameById.get(change.customerId) ?? "Customer"}
                    </Link>
                  ) : null}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatDate(change.at)}
                  </span>
                </div>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {change.text}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Upcoming renewals</h2>
        </div>
        {upcomingRenewals.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No upcoming renewals in the next 30 days.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {upcomingRenewals.map(({ customer, daysAway }) => (
              <li
                key={customer.customerId}
                className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <Link
                    href={`/customers/${customer.customerId}`}
                    className="font-medium hover:underline"
                  >
                    {customer.name}
                  </Link>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    Service period ends {relativeDayLabel(daysAway)}
                    {customer.lastCall
                      ? ` · Last call: ${callTypeLabel(customer.lastCall.callType)}`
                      : ""}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {customer.openActionCount} open action
                    {customer.openActionCount === 1 ? "" : "s"} ·{" "}
                    {customer.openBlockerCount} blocker
                    {customer.openBlockerCount === 1 ? "" : "s"}
                  </p>
                </div>
                <Link
                  href={`/customers/${customer.customerId}`}
                  className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                >
                  Review customer
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium">Upcoming customer calls</h2>
        <UpcomingMeetings supabase={supabase} showRequestAction />
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Recent conversations</h2>
        </div>
        {recentMeetings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No recent conversations with intelligence ready yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {recentMeetings.map((m) => (
              <li
                key={m.meetingId}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/meetings/${m.meetingId}/recap`}
                    className="font-medium hover:underline"
                  >
                    {m.customerName ?? "Unlinked meeting"}
                  </Link>
                  {m.callType ? (
                    <StatusBadge tone="info">
                      {callTypeLabel(m.callType)}
                    </StatusBadge>
                  ) : null}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatDate(m.scheduledStart)}
                  </span>
                </div>
                {m.summary ? (
                  <p className="text-zinc-600 dark:text-zinc-400">
                    {m.summary}
                  </p>
                ) : null}
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
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

      <Link href="/integrations" className="w-fit text-sm underline">
        Integrations
      </Link>
    </main>
  );
}
