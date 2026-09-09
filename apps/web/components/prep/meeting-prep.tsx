import Link from "next/link";
import type { CallTypeSpecific } from "@applywizz/ai";
import type {
  MeetingPrepData,
  PrepCallRecordSummary,
} from "@applywizz/domain/meeting-prep";
import { StatusBadge } from "../admin/status-badge";
import {
  EvidenceSegments,
  type EvidenceSegment,
} from "../customer-truth/evidence-segments";

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

function callTypeLabel(callType: string | null) {
  if (!callType) return "Call";
  return CALL_TYPE_LABEL[callType] ?? callType;
}

function formatDateTime(value: string) {
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
  if (Array.isArray(value)) return value.join(", ");
  return JSON.stringify(value);
}

function humanizeFieldKey(fieldKey: string) {
  return fieldKey.replaceAll("_", " ");
}

export function MeetingPrep({ prep }: { prep: MeetingPrepData }) {
  const segmentById = new Map(
    prep.previousMeeting.status === "ready"
      ? prep.previousMeeting.transcriptSegments.map((s) => [s.id, s])
      : [],
  );
  const overdueOpenItems = prep.openItems.filter(
    (i) =>
      i.recordType !== "blocker" &&
      i.dueAt &&
      i.dueAt < new Date().toISOString(),
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href="/home"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          Back to AM home
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {prep.customer?.name ?? "Unlinked meeting"}
          </h1>
          {prep.callType ? (
            <StatusBadge tone="info">
              {callTypeLabel(prep.callType)}
            </StatusBadge>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {formatDateTime(prep.scheduledAt)}
          {prep.customer?.lifecycleStage
            ? ` · ${prep.customer.lifecycleStage}`
            : ""}
          {prep.serviceEnd
            ? ` · Service ends ${formatDateTime(prep.serviceEnd)}`
            : ""}
        </p>
        {prep.journey.previousCall || prep.journey.nextCall ? (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {prep.journey.previousCall
              ? `Previous: ${callTypeLabel(prep.journey.previousCall.callType)}`
              : "First tracked call"}
            {prep.journey.nextCall
              ? ` · Next: ${callTypeLabel(prep.journey.nextCall.callType)} on ${formatDateTime(prep.journey.nextCall.scheduledAt)}`
              : ""}
          </p>
        ) : null}
      </div>

      {prep.recommendedFocus.length > 0 && (
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium">
            Recommended focus for this call
          </h2>
          <ul className="mt-2 list-inside list-disc text-sm text-zinc-700 dark:text-zinc-300">
            {prep.recommendedFocus.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="Last conversation" />
        {prep.previousMeeting.status === "none" ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No prior conversation — this is the first call.
          </p>
        ) : prep.previousMeeting.status === "not_ready" ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            Meeting prep will appear once the previous meeting&apos;s
            intelligence is ready.
          </p>
        ) : (
          <div className="flex flex-col gap-3 px-4 py-3 text-sm">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {callTypeLabel(prep.previousMeeting.callType)} ·{" "}
              {formatDateTime(prep.previousMeeting.scheduledAt)}
            </p>
            <p className="text-zinc-700 dark:text-zinc-300">
              {prep.previousMeeting.summary}
            </p>
            {prep.previousMeeting.confirmedTruthChanges.length > 0 && (
              <div>
                <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  Confirmed changes
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {prep.previousMeeting.confirmedTruthChanges.map((c) => (
                    <li key={c.fieldKey}>
                      {humanizeFieldKey(c.fieldKey)}: {formatValue(c.value)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {prep.previousMeeting.keyActions.length > 0 && (
              <RecordList
                title="Key actions / commitments"
                records={prep.previousMeeting.keyActions}
                segmentById={segmentById}
              />
            )}
            {prep.previousMeeting.blockers.length > 0 ? (
              <RecordList
                title="Blockers / open questions"
                records={prep.previousMeeting.blockers}
                segmentById={segmentById}
              />
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                No blockers or open questions from the last call.
              </p>
            )}
          </div>
        )}
      </section>

      {prep.previousMeeting.status === "ready" &&
        prep.previousMeeting.callTypeSpecific && (
          <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <SectionHeader
              title={`${callTypeLabel(prep.previousMeeting.callTypeSpecific.callType)} prep`}
            />
            <div className="divide-y divide-zinc-100 px-4 dark:divide-zinc-900">
              {getCallTypeSpecificNotes(
                prep.previousMeeting.callTypeSpecific,
              ).map((note) => (
                <div
                  key={`${note.label}-${note.text}`}
                  className="py-2 text-sm"
                >
                  <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    {note.label}:
                  </span>{" "}
                  {note.text}
                </div>
              ))}
            </div>
          </section>
        )}

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="Open items from previous calls" />
        {prep.openItems.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No open actions.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {prep.openItems.map((item) => {
              const overdue = overdueOpenItems.some((o) => o.id === item.id);
              return (
                <li
                  key={item.id}
                  className="flex items-start justify-between gap-3 px-4 py-3 text-sm"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone={overdue ? "critical" : "neutral"}>
                        {RECORD_TYPE_LABELS[item.recordType] ?? item.recordType}
                      </StatusBadge>
                      {item.dueAt ? (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">
                          Due {formatDateTime(item.dueAt)}
                          {overdue ? " (overdue)" : ""}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1">{item.description}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="Current customer truth" />
        {prep.currentTruth.filter((f) => f.provenance !== "none").length ===
        0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No Customer Truth on record yet.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {prep.currentTruth
              .filter((f) => f.provenance !== "none")
              .map((f) => (
                <li
                  key={f.fieldKey}
                  className="flex items-center justify-between px-4 py-2 text-sm"
                >
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {humanizeFieldKey(f.fieldKey)}
                  </span>
                  <span className="font-medium">
                    {formatValue(f.currentValue)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="Pending confirmations" />
        {prep.pendingTruth.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No pending Customer Truth changes.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {prep.pendingTruth.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span>
                  {humanizeFieldKey(f.fieldKey)}: {formatValue(f.value)}
                </span>
                {prep.customer ? (
                  <Link
                    href={`/customers/${prep.customer.id}`}
                    className="text-xs text-zinc-500 hover:underline dark:text-zinc-400"
                  >
                    Review
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="Recent changes" />
        {prep.recentChanges.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">
            No recently confirmed changes.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {prep.recentChanges.map((c) => (
              <li
                key={`${c.fieldKey}-${c.confirmedAt}`}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span>
                  {humanizeFieldKey(c.fieldKey)}: {formatValue(c.value)}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDateTime(c.confirmedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Codex Pass 2 (BLOCKING, fixed): the domain layer already loaded
 * `previousMeeting.callTypeSpecific` but this component never rendered
 * it — the required call-type-specific prep section (§"MEETING PREP
 * STRUCTURE" > "CALL-TYPE-SPECIFIC PREP") was silently missing. This is
 * the AM-facing internal prep page — same audience/precedent as the
 * internal recap page's own `getCallSpecificNotes`
 * (`meeting-recap.tsx`), which already renders every field below
 * (including renewal's `churnRiskEvidence`) as real evidenced AM-facing
 * context, not a computed score. This is deliberately a DIFFERENT,
 * broader allowlist than `deriveRecommendedFocus`'s narrow "recommended
 * focus" composer (which still never reads churn/objection fields) —
 * showing the AM the full internal context here is not the same as
 * feeding it into an automated risk signal.
 */
function getCallTypeSpecificNotes(
  specific: CallTypeSpecific,
): Array<{ label: string; text: string }> {
  const notes: Array<{ label: string; text: string }> = [];
  const add = (label: string, claims: Array<{ text: string }>) => {
    for (const claim of claims) notes.push({ label, text: claim.text });
  };

  switch (specific.callType) {
    case "discovery":
      if (!specific.onboardingCompleteness.complete) {
        notes.push({
          label: "Onboarding incomplete",
          text: `Missing: ${specific.onboardingCompleteness.missingFields.join(", ") || "unspecified fields"}`,
        });
      }
      add("Goal", specific.goals);
      add("Constraint", specific.constraints);
      add("New information", specific.newInformation);
      add("Resume team need", specific.resumeTeamNeeds);
      for (const c of specific.contradictionsWithOnboarding) {
        notes.push({
          label: "Contradicts onboarding",
          text: `${humanizeFieldKey(c.fieldKey)}: onboarding said "${formatValue(c.onboardingValue)}", customer said "${formatValue(c.statedValue)}"`,
        });
      }
      break;
    case "resume_review":
      notes.push({ label: "Approval state", text: specific.approvalState });
      add("Requested change", specific.resumeChangesRequested);
      add("Accepted change", specific.resumeChangesAccepted);
      add("Rejected change", specific.resumeChangesRejected);
      add("Positioning change", specific.positioningChanges);
      add("Skill correction", specific.skillCorrections);
      add("Role targeting change", specific.roleTargetingChanges);
      break;
    case "orientation":
      notes.push({
        label: "Initial experience",
        text: specific.initialExperienceSentiment,
      });
      add("Confusion point", specific.confusionPoints);
      add("Application quality concern", specific.applicationQualityConcerns);
      add("Targeting complaint", specific.targetingComplaints);
      add("Immediate corrective action", specific.immediateCorrectiveActions);
      break;
    case "progress":
      notes.push({
        label: "Application activity",
        text: `${specific.applicationsSubmittedCount ?? "—"} submitted · ${specific.responsesCount ?? "—"} responses · ${specific.screensCount ?? "—"} screens · ${specific.interviewsCount ?? "—"} interviews`,
      });
      add("Working", specific.working);
      add("Not working", specific.notWorking);
      add("Complaint", specific.complaints);
      add("Strategy change", specific.strategyChanges);
      break;
    case "renewal":
      notes.push({
        label: "Renewal decision",
        text: specific.renewalDecision,
      });
      add("Value delivered", specific.valueDelivered);
      add("Unresolved problem", specific.unresolvedProblems);
      add("Objection", specific.objections);
      add("Churn risk evidence", specific.churnRiskEvidence);
      add("Next month strategy", specific.nextMonthStrategy);
      break;
  }

  return notes;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
  );
}

function RecordList({
  title,
  records,
  segmentById,
}: {
  title: string;
  records: PrepCallRecordSummary[];
  segmentById: Map<string, EvidenceSegment>;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {title}
      </p>
      <ul className="mt-1 flex flex-col gap-2">
        {records.map((r) => (
          <li key={r.id}>
            <p>
              <span className="text-zinc-500 dark:text-zinc-400">
                {RECORD_TYPE_LABELS[r.recordType] ?? r.recordType}:
              </span>{" "}
              {r.description}
            </p>
            <EvidenceSegments
              segments={r.evidenceSegmentIds
                .map((id) => segmentById.get(id))
                .filter((s): s is EvidenceSegment => Boolean(s))}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
