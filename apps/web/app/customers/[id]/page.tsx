import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getEffectiveCustomerTruth,
  isSemanticallySameValue,
} from "@applywizz/domain/customer-context";
import { ConfirmRejectActions } from "@/components/customer-truth/confirm-reject-actions";
import { RefreshCrmButton } from "@/components/customer-truth/refresh-crm-button";
import {
  EvidenceSegments,
  type EvidenceSegment,
} from "@/components/customer-truth/evidence-segments";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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

// M10: Customer Truth review + history on one page (sections A+B of the
// locked spec — same data, split only by status). RLS scopes every
// query to whatever the signed-in user (own/manager-in-tree/admin) can
// see; this page never re-implements that authorization, only displays
// it and calls the confirm/reject RPCs via ConfirmRejectActions.
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
    .select("id, name, lifecycle_stage")
    .eq("id", id)
    .maybeSingle();
  if (customerError) throw customerError;
  if (!customer) notFound();

  const { data: current, error: currentError } = await supabase
    .from("customer_truth_current")
    .select("field_key, value")
    .eq("customer_id", id);
  if (currentError) throw currentError;
  // customer_truth_current is a VIEW — the generated type marks every
  // column nullable regardless of the base table's real NOT NULL
  // constraints on field_key; this is a codegen gap, not a real
  // nullability (matches the pattern already used elsewhere in this repo
  // for generated-type gaps).
  const currentByField = new Map<string, unknown>(
    (current ?? []).map((row) => [row.field_key as string, row.value]),
  );

  // M10 amendment: effective truth = confirmed Signal fact if one exists,
  // else the CRM baseline (never the reverse — a CRM refresh can never
  // overwrite a confirmed Signal fact). Only covers the fields the CRM
  // baseline actually maps to; other Signal-only fields (skills,
  // concerns, application_strategy, ...) are Signal-confirmed-only and
  // stay in currentByField above.
  const effectiveTruth = await getEffectiveCustomerTruth(supabase, id);
  const effectiveByField = new Map(
    effectiveTruth.map((f) => [f.fieldKey as string, f]),
  );
  const signalOnlyFields = Array.from(currentByField.entries()).filter(
    ([fieldKey]) => !effectiveByField.has(fieldKey),
  );

  const { data: facts, error: factsError } = await supabase
    .from("customer_truth_facts")
    .select(
      "id, field_key, value, status, previous_fact_id, source_meeting_id, evidence_segment_ids, detected_at, confirmed_by_membership_id, confirmed_at, rejected_by_membership_id, rejected_at, rejection_reason",
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

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href="/customers"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← All customers
        </Link>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">
          {customer.name}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {customer.lifecycle_stage ?? "Lifecycle stage unknown"}
        </p>
      </div>

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
              // §11: compare against EFFECTIVE current truth (confirmed
              // Signal fact if any, else the CRM baseline) — deterministic
              // structured comparison, no second AI call.
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
}
