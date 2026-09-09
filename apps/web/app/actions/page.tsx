import Link from "next/link";
import { ResolveAction } from "@/components/actions/resolve-action";
import {
  EvidenceSegments,
  type EvidenceSegment,
} from "@/components/customer-truth/evidence-segments";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

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

// M10: outstanding call_records (M9-detected action items, commitments,
// decisions, questions, blockers) as plain operational work — no kanban,
// no PM system, a list with Complete/Dismiss. RLS scopes visibility to
// whatever the signed-in user (own meetings/manager-in-tree/admin) can
// see.
export default async function ActionsPage() {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();

  const { data: records, error } = await supabase
    .from("call_records")
    .select(
      "id, meeting_id, customer_id, record_type, description, owner_type, owner_membership_id, external_owner_name, due_at, evidence_segment_ids, created_at",
    )
    .eq("status", "detected")
    .order("due_at", { ascending: true, nullsFirst: false });
  if (error) throw error;

  // M14: a manager viewing their team's actions needs to know WHICH
  // customer each one is about (an AM viewing their own didn't strictly
  // need this — they know their own customers — but it was harmless to
  // add for everyone).
  const customerIds = Array.from(
    new Set(
      (records ?? [])
        .map((r) => r.customer_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const customerNameById = new Map<string, string>();
  if (customerIds.length > 0) {
    const { data: customers, error: customersError } = await supabase
      .from("customers")
      .select("id, name")
      .in("id", customerIds);
    if (customersError) throw customersError;
    for (const customer of customers ?? [])
      customerNameById.set(customer.id, customer.name);
  }

  const meetingIds = Array.from(
    new Set((records ?? []).map((r) => r.meeting_id)),
  );
  const meetingTitleById = new Map<string, string>();
  if (meetingIds.length > 0) {
    const { data: meetings, error: meetingsError } = await supabase
      .from("meetings")
      .select("id, title")
      .in("id", meetingIds);
    if (meetingsError) throw meetingsError;
    for (const meeting of meetings ?? [])
      meetingTitleById.set(meeting.id, meeting.title);
  }

  const ownerMembershipIds = Array.from(
    new Set(
      (records ?? [])
        .map((r) => r.owner_membership_id)
        .filter((v): v is string => Boolean(v)),
    ),
  );
  const ownerNameByMembership = new Map<string, string>();
  if (ownerMembershipIds.length > 0) {
    const { data: members, error: membersError } = await supabase
      .from("organization_memberships")
      .select("id, display_name")
      .in("id", ownerMembershipIds);
    if (membersError) throw membersError;
    for (const member of members ?? [])
      ownerNameByMembership.set(member.id, member.display_name);
  }

  const allEvidenceIds = Array.from(
    new Set((records ?? []).flatMap((r) => r.evidence_segment_ids ?? [])),
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

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Actions</h1>

      {(records ?? []).length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing outstanding.</p>
      ) : (
        <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
          {(records ?? []).map((record) => {
            const ownerLabel = record.owner_membership_id
              ? ownerNameByMembership.get(record.owner_membership_id)
              : (record.external_owner_name ?? record.owner_type);
            const dueLabel = formatDate(record.due_at);
            const evidence = (record.evidence_segment_ids ?? [])
              .map((id) => segmentsById.get(id))
              .filter((s): s is EvidenceSegment => Boolean(s));

            return (
              <li key={record.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="info">
                        {RECORD_TYPE_LABELS[record.record_type] ??
                          record.record_type}
                      </StatusBadge>
                      {dueLabel && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          Due {dueLabel}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm">{record.description}</p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {record.customer_id ? (
                        <>
                          <Link
                            href={`/customers/${record.customer_id}`}
                            className="hover:underline"
                          >
                            {customerNameById.get(record.customer_id) ??
                              "Customer"}
                          </Link>{" "}
                          ·{" "}
                        </>
                      ) : null}
                      Owner: {ownerLabel ?? "Unassigned"} ·{" "}
                      <Link
                        href={`/admin/meetings/${record.meeting_id}`}
                        className="hover:underline"
                      >
                        {meetingTitleById.get(record.meeting_id) ??
                          "Source meeting"}
                      </Link>
                    </p>
                  </div>
                  <ResolveAction recordId={record.id} />
                </div>
                <EvidenceSegments segments={evidence} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
