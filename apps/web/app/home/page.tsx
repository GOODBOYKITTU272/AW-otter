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
import { getAMLiveAlerts } from "@applywizz/domain";

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

  const [portfolio, org, recentMeetings, liveAlerts] = await Promise.all([
    getPortfolioOverview(supabase, membership.organizationId),
    supabase
      .from("organizations")
      .select("timezone")
      .eq("id", membership.organizationId)
      .maybeSingle(),
    listRecentMeetingSummaries(supabase, { limit: 5 }),
    getAMLiveAlerts(supabase, membership.membershipId),
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
    <main className="flex flex-1 flex-col bg-[#F5F5F5]">
      <header className="border-b border-[#1E1E1E]/10 bg-white px-8 py-4 shadow-sm sticky top-0 z-10">
        <div className="flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="flex items-center gap-3">
            <Link href="/home" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center">
                <span className="text-sm font-bold text-white">AW</span>
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-base font-bold tracking-tight text-[#1E1E1E]">
                  Wizz Echo
                </span>
                <span className="text-[10px] font-medium text-[#2C76FF] uppercase tracking-wide">
                  AM
                </span>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-[#2C76FF]/10 flex items-center justify-center">
                <span className="text-xs font-bold text-[#2C76FF]">
                  {membership.displayName.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
                </span>
              </div>
              <div className="flex flex-col leading-tight">
                <span className="text-sm font-medium text-[#1E1E1E]">
                  {membership.displayName}
                </span>
                <span className="text-xs text-[#1E1E1E]/50">Account Manager</span>
              </div>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col gap-6 p-8 max-w-6xl mx-auto w-full">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight text-[#1E1E1E]">
            {firstName}&apos;s day
          </h1>
          <p className="text-base text-[#1E1E1E]/70">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>

      {/* Live Alerts - Phase 1 */}
      {liveAlerts.length > 0 ? (
        <section className="rounded-xl border-2 border-[#FF5C5C] bg-gradient-to-br from-[#FF5C5C]/10 to-[#FFDE59]/5 shadow-xl">
          <div className="border-b-2 border-[#FF5C5C]/30 bg-[#FF5C5C]/5 px-5 py-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">🚨</span>
              <h2 className="text-base font-bold text-[#FF5C5C]">
                URGENT: {liveAlerts.length} Live Alert{liveAlerts.length === 1 ? "" : "s"}
              </h2>
            </div>
          </div>
          <ul className="divide-y divide-[#FF5C5C]/20">
            {liveAlerts.map((alert) => (
              <li key={alert.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <StatusBadge tone={alert.severity === "critical" ? "critical" : "warning"}>
                        {alert.alertType === "bot_lobby_stuck" 
                          ? "Bot Stuck in Lobby" 
                          : alert.alertType === "customer_missing_warn"
                            ? "Customer Missing 10min"
                            : "Customer Missing 15min"}
                      </StatusBadge>
                      {alert.occurrenceCount > 1 ? (
                        <span className="text-xs text-[#1E1E1E]/60">
                          × {alert.occurrenceCount}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm font-medium text-[#1E1E1E] mb-1">
                      {alert.message}
                    </p>
                    <p className="text-xs text-[#1E1E1E]/70">
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
                    Take Action →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {nextCall ? (
        <section className="rounded-2xl border-2 border-[#2C76FF]/30 bg-white p-8 shadow-xl">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="rounded-full bg-[#2C76FF]/10 p-3">
                  <svg className="h-8 w-8 text-[#2C76FF]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider text-[#2C76FF]">
                    Next up
                  </p>
                  <h2 className="text-2xl font-bold text-[#1E1E1E] mt-1">
                    <Link
                      href={`/customers/${nextCall.customer.customerId}`}
                      className="hover:underline"
                    >
                      {nextCall.customer.name}
                    </Link>
                  </h2>
                </div>
              </div>

              <div className="flex items-center gap-3 mb-4">
                <p className="text-sm text-[#1E1E1E]/70">
                  {callTypeLabel(nextCall.call.callType)}
                </p>
                <span className="inline-flex items-center rounded-md bg-[#2C76FF]/10 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-[#2C76FF]">
                  {nextCall.call.callType?.replace('_', ' ') ?? 'CALL'}
                </span>
              </div>

              <div className="flex items-center gap-2 text-sm text-[#1E1E1E]/70 mb-6">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{formatTime(nextCall.call.scheduledAt)} – {new Date(new Date(nextCall.call.scheduledAt).getTime() + 45*60000).toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})} · 🎯 Microsoft Teams Meeting</span>
              </div>

              {nextCallRemembers.length > 0 ? (
                <div className="rounded-lg border border-[#1E1E1E]/10 bg-[#F5F5F5] p-4 mb-6">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#1E1E1E]/70 mb-2">
                    Echo remembers
                  </p>
                  <ul className="space-y-1.5 text-sm text-[#1E1E1E]/80">
                    {nextCallRemembers.slice(0, 3).map((item, idx) => (
                      <li key={idx} className="flex items-start gap-2">
                        <span className="text-[#2C76FF] mt-0.5">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                {nextCall.call.meetingId ? (
                  <button className="rounded-lg bg-[#29FE29] px-6 py-3 text-sm font-bold text-[#1E1E1E] shadow-lg hover:bg-[#29FE29]/90 transition-all flex items-center gap-2 min-h-[44px]">
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M19.5 3h-15A2.5 2.5 0 002 5.5v13A2.5 2.5 0 004.5 21h15a2.5 2.5 0 002.5-2.5v-13A2.5 2.5 0 0019.5 3zM10 16.5v-9l6 4.5-6 4.5z"/>
                    </svg>
                    Join Teams →
                  </button>
                ) : (
                  <span className="rounded-lg bg-[#1E1E1E]/5 px-6 py-3 text-sm font-medium text-[#1E1E1E]/50">
                    Scheduled
                  </span>
                )}
                <Link
                  href={`/customers/${nextCall.customer.customerId}`}
                  className="rounded-lg border-2 border-[#1E1E1E]/10 bg-white px-6 py-3 text-sm font-semibold text-[#1E1E1E] hover:bg-[#F5F5F5] transition-all min-h-[44px] flex items-center"
                >
                  View customer
                </Link>
              </div>
            </div>

            <div className="text-right">
              <p className="text-xs font-medium text-[#1E1E1E]/50 mb-1">Starts in</p>
              <p className="text-4xl font-bold text-[#2C76FF]">
                {Math.floor((new Date(nextCall.call.scheduledAt).getTime() - Date.now()) / 60000)} min
              </p>
            </div>
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
        <div className="border-b border-[#1E1E1E]/10 px-6 py-4">
          <h2 className="text-lg font-semibold text-[#1E1E1E]">Today&apos;s meetings</h2>
        </div>
        {todaysCalls.length === 0 ? (
          <p className="px-6 py-8 text-sm text-[#1E1E1E]/60">
            No customer calls scheduled today.
          </p>
        ) : (
          <ul className="divide-y divide-[#1E1E1E]/10">
            {todaysCalls.map(({ customer, call }) => {
              const callTypeUpper = (call.callType?.toUpperCase().replace('_', ' ') ?? 'CALL');
              const callTypeBadgeColor = 
                call.callType === 'discovery' ? 'bg-[#2C76FF] text-white' :
                call.callType === 'orientation' ? 'bg-[#8B5CF6] text-white' :
                call.callType === 'progress_review' ? 'bg-[#29FE29] text-[#1E1E1E]' :
                call.callType === 'renewal_discussion' ? 'bg-[#FFDE59] text-[#1E1E1E]' :
                'bg-[#1E1E1E]/10 text-[#1E1E1E]';
              
              const isCompleted = call.scheduledAt && new Date(call.scheduledAt) < new Date();
              const statusBadge = isCompleted ? 
                { label: 'Completed', color: 'bg-[#29FE29]/10 text-[#29FE29] border border-[#29FE29]/30' } :
                { label: 'Upcoming', color: 'bg-[#2C76FF]/10 text-[#2C76FF] border border-[#2C76FF]/30' };

              return (
                <li
                  key={`${customer.customerId}-${call.scheduledAt}`}
                  className="flex items-center justify-between gap-4 px-6 py-5 hover:bg-[#F5F5F5]/50 transition-colors"
                >
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="flex flex-col items-center min-w-[80px]">
                      <span className="text-xs font-medium text-[#1E1E1E]/50">
                        {formatTime(call.scheduledAt).split(' ')[0]}
                      </span>
                      <span className="text-2xl font-bold text-[#1E1E1E]">
                        {formatTime(call.scheduledAt).split(' ')[1]}
                      </span>
                    </div>

                    <div className="h-12 w-px bg-[#1E1E1E]/10" />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Link
                          href={`/customers/${customer.customerId}`}
                          className="font-semibold text-[#1E1E1E] hover:underline truncate"
                        >
                          {customer.name}
                        </Link>
                      </div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-[#1E1E1E]/70">
                          {callTypeLabel(call.callType)}
                        </p>
                        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${callTypeBadgeColor}`}>
                          {callTypeUpper}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge.color}`}>
                      {statusBadge.label}
                    </span>
                    {call.meetingId ? (
                      <Link
                        href={`/meetings/${call.meetingId}`}
                        className="text-sm text-[#2C76FF] hover:underline font-medium whitespace-nowrap min-h-[44px] flex items-center"
                      >
                        View →
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
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
