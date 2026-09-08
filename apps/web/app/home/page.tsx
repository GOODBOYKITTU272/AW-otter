import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { StatusBadge } from "@/components/admin/status-badge";
import { ResolveAction } from "@/components/actions/resolve-action";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { listRecentMeetingSummaries } from "@applywizz/domain/meeting-recap";

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

function formatDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// M11: the real AM home. RLS alone scopes every query below to this AM's
// own portfolio (owner_membership_id = current_membership_id()) — same
// convention /actions and /customers/:id already use, no explicit filter
// needed since this route is account_manager-only.
export default async function AccountManagerHomePage() {
  const membership = await requireRole(["account_manager"]);
  const supabase = await getSupabaseServerClient();

  const nowIso = new Date().toISOString();

  const [
    proposedTruthCount,
    overdueActionCount,
    failedIntelligenceCount,
    recentMeetings,
    openActions,
  ] = await Promise.all([
    supabase
      .from("customer_truth_facts")
      .select("id", { count: "exact", head: true })
      .eq("status", "proposed"),
    supabase
      .from("call_records")
      .select("id", { count: "exact", head: true })
      .eq("status", "detected")
      .lt("due_at", nowIso),
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("status", "failed"),
    listRecentMeetingSummaries(supabase, { limit: 5 }),
    supabase
      .from("call_records")
      .select("id, meeting_id, record_type, description, due_at, customer_id")
      .eq("status", "detected")
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(5),
  ]);
  if (proposedTruthCount.error) throw proposedTruthCount.error;
  if (overdueActionCount.error) throw overdueActionCount.error;
  if (failedIntelligenceCount.error) throw failedIntelligenceCount.error;
  if (openActions.error) throw openActions.error;

  const openActionRows = openActions.data ?? [];
  const actionCustomerIds = Array.from(
    new Set(
      openActionRows
        .map((r) => r.customer_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const customerNameById = new Map<string, string>();
  if (actionCustomerIds.length > 0) {
    const { data: customers, error: customersError } = await supabase
      .from("customers")
      .select("id, name")
      .in("id", actionCustomerIds);
    if (customersError) throw customersError;
    for (const c of customers ?? []) customerNameById.set(c.id, c.name);
  }

  const attentionItems = [
    proposedTruthCount.count
      ? {
          text: `${proposedTruthCount.count} proposed customer truth change${proposedTruthCount.count === 1 ? "" : "s"} waiting for confirmation`,
          href: "/customers",
        }
      : null,
    overdueActionCount.count
      ? {
          text: `${overdueActionCount.count} overdue customer action${overdueActionCount.count === 1 ? "" : "s"}`,
          href: "/actions",
        }
      : null,
    failedIntelligenceCount.count
      ? {
          text: `${failedIntelligenceCount.count} call${failedIntelligenceCount.count === 1 ? "" : "s"} failed intelligence processing`,
          href: null,
        }
      : null,
  ].filter(
    (item): item is { text: string; href: string | null } => item !== null,
  );

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Home</h1>
        <SignOutButton />
      </div>
      <p className="-mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        Signed in as {membership.displayName}.
      </p>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Needs your attention</h2>
        </div>
        {attentionItems.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Nothing needs attention.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {attentionItems.map((item) =>
              item.href ? (
                <li key={item.text}>
                  <Link
                    href={item.href}
                    className="block px-4 py-2 text-sm hover:underline"
                  >
                    {item.text}
                  </Link>
                </li>
              ) : (
                <li key={item.text} className="px-4 py-2 text-sm">
                  {item.text}
                </li>
              ),
            )}
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
                      {CALL_TYPE_LABEL[m.callType] ?? m.callType}
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
                  action{m.openActionCount === 1 ? "" : "s"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Open actions</h2>
          <Link
            href="/actions"
            className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
          >
            View all
          </Link>
        </div>
        {openActionRows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Nothing outstanding.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {openActionRows.map((record) => (
              <li
                key={record.id}
                className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="info">
                      {RECORD_TYPE_LABELS[record.record_type] ??
                        record.record_type}
                    </StatusBadge>
                    {record.due_at ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Due {formatDate(record.due_at)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1">{record.description}</p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {record.customer_id
                      ? customerNameById.get(record.customer_id)
                      : null}
                  </p>
                </div>
                <ResolveAction recordId={record.id} />
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
