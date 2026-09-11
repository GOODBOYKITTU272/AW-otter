import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getEffectiveCustomerTruth,
  isSemanticallySameValue,
} from "@applywizz/domain/customer-context";
import { listRecentMeetingSummaries } from "@applywizz/domain/meeting-recap";
import { ConfirmRejectActions } from "@/components/customer-truth/confirm-reject-actions";
import { RefreshCrmButton } from "@/components/customer-truth/refresh-crm-button";
import { ResolveAction } from "@/components/actions/resolve-action";
import {
  EvidenceSegments,
  type EvidenceSegment,
} from "@/components/customer-truth/evidence-segments";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AskSignalPanel } from "@/components/ask-signal/ask-signal-panel";
import { CustomerDetailTabs } from "@/components/customer/customer-tabs";

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

function formatShortDate(value: string | null) {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function humanizeFieldKey(fieldKey: string) {
  return fieldKey.replaceAll("_", " ");
}

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();
  const { id } = await params;

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, name, lifecycle_stage, owner_membership_id")
    .eq("id", id)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer) notFound();

  const { data: ownerMembership, error: ownerError } = await supabase
    .from("organization_memberships")
    .select("display_name")
    .eq("id", customer.owner_membership_id)
    .maybeSingle();
  if (ownerError) throw ownerError;

  const { data: current, error: currentError } = await supabase
    .from("customer_truth_current")
    .select("field_key, value")
    .eq("customer_id", id);
  if (currentError) throw currentError;

  const currentByField = new Map<string, unknown>(
    (current ?? [])
      .filter((row): row is typeof row & { field_key: string } => Boolean(row.field_key))
      .map((row) => [row.field_key, row.value]),
  );

  const effectiveTruth = await getEffectiveCustomerTruth(supabase, id);
  const effectiveByField = new Map<string, (typeof effectiveTruth)[number]>(
    effectiveTruth.map((item) => [item.fieldKey, item]),
  );

  const signalOnlyFields = Array.from(currentByField.entries()).filter(
    ([fieldKey]) => !effectiveByField.has(fieldKey),
  );

  const { data: facts, error: factsError } = await supabase
    .from("customer_truth_facts")
    .select(
      "id, field_key, value, status, detected_at, confirmed_at, rejected_at, confirmed_by_membership_id, rejected_by_membership_id, rejection_reason, evidence_segment_ids",
    )
    .eq("customer_id", id)
    .order("detected_at", { ascending: false });
  if (factsError) throw factsError;

  const proposed = (facts ?? []).filter((f) => f.status === "proposed");
  const history = (facts ?? []).filter(
    (f) => f.status === "rejected" || f.status === "superseded",
  );

  const allEvidenceIds = Array.from(
    new Set((facts ?? []).flatMap((f) => f.evidence_segment_ids ?? [])),
  );
  const segmentsById = new Map<string, EvidenceSegment>();
  if (allEvidenceIds.length > 0) {
    const { data: segments, error: segmentsError } = await supabase
      .from("transcript_segments")
      .select("id, start_ms, end_ms, original_text, speaker_label")
      .in("id", allEvidenceIds);
    if (segmentsError) throw segmentsError;
    for (const segment of segments ?? []) segmentsById.set(segment.id, segment);
  }

  const membershipIds = Array.from(
    new Set(
      (facts ?? []).flatMap((f) =>
        [f.confirmed_by_membership_id, f.rejected_by_membership_id].filter(
          (v): v is string => Boolean(v),
        ),
      ),
    ),
  );
  const nameByMembership = new Map<string, string>();
  if (membershipIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .from("organization_memberships")
      .select("id, display_name")
      .in("id", membershipIds);
    if (membersError) throw membersError;
    for (const member of members ?? [])
      nameByMembership.set(member.id, member.display_name);
  }

  function evidenceFor(ids: string[] | null) {
    return (ids ?? [])
      .map((segId) => segmentsById.get(segId))
      .filter((s): s is EvidenceSegment => Boolean(s));
  }

  const recentMeetings = await listRecentMeetingSummaries(supabase, {
    customerId: id,
    limit: 10,
  });

  const { data: openActionRows, error: openActionsError } = await supabase
    .from("call_records")
    .select(
      "id, meeting_id, record_type, description, due_at, evidence_segment_ids",
    )
    .eq("customer_id", id)
    .eq("status", "detected")
    .order("due_at", { ascending: true, nullsFirst: false });
  if (openActionsError) throw openActionsError;

  const { data: journeyRows, error: journeyError } = await supabase
    .from("scheduler_calls")
    .select(
      "id, canonical_call_type, scheduled_at, external_status, meeting_id",
    )
    .eq("customer_id", id)
    .order("scheduled_at", { ascending: true });
  if (journeyError) throw journeyError;

  // Render Tabs
  const overviewContent = (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Open actions &amp; commitments</h2>
        </div>
        {(openActionRows ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No outstanding commitments.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {(openActionRows ?? []).map((record) => (
              <li key={record.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="info">
                        {RECORD_TYPE_LABELS[record.record_type] ??
                          record.record_type}
                      </StatusBadge>
                      {record.due_at ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          Due {formatShortDate(record.due_at)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm font-medium">{record.description}</p>
                  </div>
                  <ResolveAction recordId={record.id} />
                </div>
                <EvidenceSegments
                  segments={evidenceFor(record.evidence_segment_ids)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Recent meetings</h2>
        </div>
        {recentMeetings.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No meetings with intelligence ready yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {recentMeetings.slice(0, 3).map((m) => (
              <li
                key={m.meetingId}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/meetings/${m.meetingId}`}
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {m.callType
                      ? (CALL_TYPE_LABEL[m.callType] ?? m.callType)
                      : "Meeting"}
                  </Link>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    {formatShortDate(m.scheduledStart)}
                  </span>
                </div>
                {m.summary ? (
                  <p className="text-zinc-600 dark:text-zinc-400 text-xs line-clamp-2">
                    {m.summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Call history &amp; journey</h2>
        </div>
        {(journeyRows ?? []).length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No scheduled or completed calls yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {(journeyRows ?? []).map((call) => (
              <li
                key={call.id}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span>
                  {CALL_TYPE_LABEL[call.canonical_call_type] ??
                    call.canonical_call_type}
                </span>
                <span className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  {formatShortDate(call.scheduled_at)}
                  <StatusBadge tone={call.meeting_id ? "success" : "neutral"}>
                    {call.meeting_id ? "Completed" : call.external_status}
                  </StatusBadge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const askEchoContent = (
    <div className="flex flex-col gap-4">
      <AskSignalPanel customerId={id} />
    </div>
  );

  const truthContent = (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Current truth</h2>
          <RefreshCrmButton customerId={customer.id} />
        </div>
        {effectiveTruth.every((f) => f.provenance === "none") &&
        signalOnlyFields.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No Customer Truth yet — confirm a proposed change below, or refresh
            from the CRM.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {effectiveTruth
              .filter((f) => f.provenance !== "none")
              .map((f) => (
                <li
                  key={f.fieldKey}
                  className="flex flex-col gap-1 px-4 py-2 text-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {humanizeFieldKey(f.fieldKey)}
                    </span>
                    <span className="font-medium">
                      {formatValue(f.currentValue)}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2 text-xs text-zinc-400">
                    {f.provenance === "signal_confirmed" ? (
                      <StatusBadge tone="success">AM-confirmed</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">CRM baseline</StatusBadge>
                    )}
                    {f.provenance === "signal_confirmed" &&
                      f.crmBaseline !== null &&
                      f.crmBaseline !== undefined &&
                      !isSemanticallySameValue(
                        f.crmBaseline,
                        f.currentValue,
                      ) && (
                        <span>CRM still says {formatValue(f.crmBaseline)}</span>
                      )}
                  </div>
                </li>
              ))}
            {signalOnlyFields.map(([fieldKey, value]) => (
              <li
                key={fieldKey}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span className="text-zinc-500 dark:text-zinc-400">
                  {humanizeFieldKey(fieldKey)}
                </span>
                <span className="font-medium">{formatValue(value)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Proposed changes</h2>
        </div>
        {proposed.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Nothing awaiting review.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {proposed.map((fact) => {
              const effectiveCurrent =
                effectiveByField.get(fact.field_key)?.currentValue ??
                currentByField.get(fact.field_key) ??
                null;
              const noChange = isSemanticallySameValue(
                effectiveCurrent,
                fact.value,
              );
              return (
                <li key={fact.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium">
                          {humanizeFieldKey(fact.field_key)}
                        </p>
                        {noChange && (
                          <StatusBadge tone="neutral">No change</StatusBadge>
                        )}
                      </div>
                      <p className="mt-1 text-sm">
                        <span className="text-zinc-400 line-through">
                          {formatValue(effectiveCurrent)}
                        </span>
                        <span className="mx-2 text-zinc-400">→</span>
                        <span className="font-medium">
                          {formatValue(fact.value)}
                        </span>
                      </p>
                      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                        Detected {formatDateTime(fact.detected_at)}
                      </p>
                    </div>
                    <ConfirmRejectActions factId={fact.id} />
                  </div>
                  <EvidenceSegments
                    segments={evidenceFor(fact.evidence_segment_ids)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">History</h2>
        </div>
        {history.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No rejected or superseded changes yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {history.map((fact) => (
              <li
                key={fact.id}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {humanizeFieldKey(fact.field_key)}
                  </span>
                  <StatusBadge
                    tone={fact.status === "rejected" ? "critical" : "neutral"}
                  >
                    {fact.status}
                  </StatusBadge>
                  <span className="text-zinc-400">
                    {formatValue(fact.value)}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {fact.status === "rejected"
                    ? `Rejected by ${
                        nameByMembership.get(
                          fact.rejected_by_membership_id ?? "",
                        ) ?? "—"
                      } · ${formatDateTime(fact.rejected_at)}${
                        fact.rejection_reason
                          ? ` · "${fact.rejection_reason}"`
                          : ""
                      }`
                    : `Superseded · was confirmed by ${
                        nameByMembership.get(
                          fact.confirmed_by_membership_id ?? "",
                        ) ?? "—"
                      } · ${formatDateTime(fact.confirmed_at)}`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );

  const meetingsContent = (
    <div className="flex flex-col gap-4">
      {recentMeetings.length === 0 ? (
        <p className="rounded-lg border border-zinc-200 p-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
          No recorded meetings for this customer yet.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {recentMeetings.map((m) => (
            <li
              key={m.meetingId}
              className="flex flex-col gap-2 p-4 text-sm hover:bg-zinc-50/50 dark:hover:bg-zinc-900/50"
            >
              <div className="flex items-center justify-between">
                <Link
                  href={`/meetings/${m.meetingId}`}
                  className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
                >
                  {m.callType ? CALL_TYPE_LABEL[m.callType] ?? m.callType : "Customer Meeting"}
                </Link>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatShortDate(m.scheduledStart)}
                </span>
              </div>
              {m.summary && (
                <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                  {m.summary}
                </p>
              )}
              <div className="flex items-center gap-4 text-xs text-zinc-500 pt-1">
                <Link
                  href={`/meetings/${m.meetingId}?tab=transcript`}
                  className="text-blue-600 hover:underline dark:text-blue-400 font-medium"
                >
                  Transcript →
                </Link>
                <Link
                  href={`/meetings/${m.meetingId}/recap`}
                  className="text-zinc-600 hover:underline dark:text-zinc-400"
                >
                  Recap details →
                </Link>
                <span>· {m.openActionCount} action{m.openActionCount === 1 ? "" : "s"}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto w-full">
      <div>
        <Link
          href="/customers"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← All customers
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
              {customer.name}
            </h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {customer.lifecycle_stage ?? "Lifecycle stage unknown"}
              {ownerMembership ? ` · Owned by ${ownerMembership.display_name}` : ""}
            </p>
          </div>
        </div>
      </div>

      <CustomerDetailTabs
        tabs={[
          { key: "overview", label: "Overview", content: overviewContent },
          { key: "ask", label: "Ask Echo", content: askEchoContent },
          {
            key: "truth",
            label: "Customer Truth",
            count: proposed.length > 0 ? proposed.length : undefined,
            content: truthContent,
          },
          {
            key: "meetings",
            label: "Meetings",
            count: recentMeetings.length > 0 ? recentMeetings.length : undefined,
            content: meetingsContent,
          },
        ]}
      />
    </div>
  );
}
