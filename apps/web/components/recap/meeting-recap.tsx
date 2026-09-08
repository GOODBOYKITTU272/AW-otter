import Link from "next/link";

import type {
  MeetingRecapFixture,
  TranscriptSegmentFixture,
} from "../../fixtures/meeting-intelligence/fixtures";
import { StatusBadge } from "../admin/status-badge";

const CALL_TYPE_LABELS = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress",
  renewal: "Renewal",
} as const;

const RECORD_TYPE_LABELS = {
  action_item: "Action",
  commitment: "Commitment",
  decision: "Decision",
  question: "Question",
  blocker: "Blocker",
} as const;

export function MeetingRecap({ recap }: { recap: MeetingRecapFixture }) {
  const segmentById = new Map(
    recap.transcriptSegments.map((segment) => [segment.id, segment]),
  );
  const callType = recap.result.callTypeSpecific?.callType;
  const blockers = recap.result.callRecords.filter(
    (record) =>
      record.recordType === "blocker" || record.recordType === "question",
  );
  const actions = recap.result.callRecords.filter(
    (record) => record.recordType === "action_item",
  );
  const commitments = recap.result.callRecords.filter(
    (record) => record.recordType === "commitment",
  );
  const callSpecificNotes = getCallSpecificNotes(recap);

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href="/home"
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          Back to AM home
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {recap.customer.name}
              </h1>
              {callType && (
                <StatusBadge tone="info">
                  {CALL_TYPE_LABELS[callType]}
                </StatusBadge>
              )}
            </div>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {formatDateTime(recap.meetingDate)} · {recap.customer.ownerName} ·{" "}
              {recap.customer.lifecycleStage}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500"
            >
              View Meeting
            </button>
            <button
              type="button"
              disabled
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm text-zinc-400 dark:border-zinc-800 dark:text-zinc-500"
            >
              Ask Signal
            </button>
          </div>
        </div>
      </div>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Summary</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          {recap.result.summary}
        </p>
      </section>

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Next Journey Step</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          {recap.nextJourneyStep}
        </p>
      </section>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <SectionHeader title="What Changed" />
        <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {recap.result.customerTruthDeltas.map((delta) => (
            <EvidenceItem
              key={delta.fieldKey}
              title={humanize(delta.fieldKey)}
              meta={`Confidence ${Math.round(delta.confidence * 100)}%`}
              evidenceSegmentIds={delta.evidenceSegmentIds}
              segmentById={segmentById}
            >
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <ValueBlock label="Previous" value={delta.previousValue} />
                <ValueBlock label="Proposed" value={delta.proposedValue} />
              </div>
            </EvidenceItem>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <RecordSection
          title="Actions"
          records={actions}
          segmentById={segmentById}
        />
        <RecordSection
          title="Commitments"
          records={commitments}
          segmentById={segmentById}
        />
      </div>

      <RecordSection
        title="Missing Info / Blockers"
        records={blockers}
        segmentById={segmentById}
        emptyText="No missing information or blockers in this fixture."
      />

      {callSpecificNotes.length > 0 && (
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <SectionHeader title="Call-Specific Notes" />
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {callSpecificNotes.map((note) => (
              <EvidenceItem
                key={`${note.label}-${note.claim.text}`}
                title={note.claim.text}
                meta={note.label}
                evidenceSegmentIds={note.claim.evidenceSegmentIds}
                segmentById={segmentById}
              />
            ))}
          </div>
        </section>
      )}

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Ask Signal</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Placeholder for M13. This fixture preview does not run retrieval,
          chat, Mem0, or live data access.
        </p>
      </section>
    </div>
  );
}

function RecordSection({
  title,
  records,
  segmentById,
  emptyText = "No records in this fixture.",
}: {
  title: string;
  records: MeetingRecapFixture["result"]["callRecords"];
  segmentById: Map<string, TranscriptSegmentFixture>;
  emptyText?: string;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <SectionHeader title={title} />
      {records.length === 0 ? (
        <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
          {emptyText}
        </p>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
          {records.map((record) => (
            <EvidenceItem
              key={`${record.recordType}-${record.description}`}
              title={record.description}
              meta={`${RECORD_TYPE_LABELS[record.recordType]} · ${ownerLabel(record)}${
                record.dueAt ? ` · Due ${formatDate(record.dueAt)}` : ""
              }`}
              evidenceSegmentIds={record.evidenceSegmentIds}
              segmentById={segmentById}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EvidenceItem({
  title,
  meta,
  evidenceSegmentIds,
  segmentById,
  children,
}: {
  title: string;
  meta: string;
  evidenceSegmentIds: string[];
  segmentById: Map<string, TranscriptSegmentFixture>;
  children?: React.ReactNode;
}) {
  return (
    <details className="group px-4 py-3">
      <summary className="cursor-pointer list-none">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{title}</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              {meta}
            </p>
          </div>
          <span className="text-xs text-zinc-400 group-open:hidden">
            Evidence
          </span>
          <span className="hidden text-xs text-zinc-400 group-open:inline">
            Hide
          </span>
        </div>
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {children}
        <div className="flex flex-col gap-2">
          {evidenceSegmentIds.map((id) => {
            const segment = segmentById.get(id);
            if (!segment) return null;

            return <TranscriptSegment key={id} segment={segment} />;
          })}
        </div>
      </div>
    </details>
  );
}

function TranscriptSegment({ segment }: { segment: TranscriptSegmentFixture }) {
  return (
    <div className="rounded-md bg-zinc-50 p-3 dark:bg-zinc-950">
      <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-mono">
          {formatTimestamp(segment.startMs)}-{formatTimestamp(segment.endMs)}
        </span>
        <span>{segment.speakerLabel}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
        {segment.originalText}
      </p>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <h2 className="text-sm font-medium">{title}</h2>
    </div>
  );
}

function ValueBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-zinc-700 dark:text-zinc-300">
        {formatUnknown(value)}
      </p>
    </div>
  );
}

function ownerLabel(
  record: MeetingRecapFixture["result"]["callRecords"][number],
) {
  return `${humanize(record.ownerType)}${record.ownerRef ? `: ${record.ownerRef}` : ""}`;
}

type RecapClaim = { text: string; evidenceSegmentIds: string[] };

function getCallSpecificNotes(recap: MeetingRecapFixture) {
  const callTypeSpecific = recap.result.callTypeSpecific;
  if (!callTypeSpecific) return [];

  const notes: Array<{ label: string; claim: RecapClaim }> = [];
  const add = (label: string, claims: RecapClaim[]) => {
    for (const claim of claims) notes.push({ label, claim });
  };

  switch (callTypeSpecific.callType) {
    case "discovery":
      add("Goal", callTypeSpecific.goals);
      add("Constraint", callTypeSpecific.constraints);
      add("New information", callTypeSpecific.newInformation);
      add("Resume team need", callTypeSpecific.resumeTeamNeeds);
      break;
    case "resume_review":
      add("Requested change", callTypeSpecific.resumeChangesRequested);
      add("Accepted change", callTypeSpecific.resumeChangesAccepted);
      add("Rejected change", callTypeSpecific.resumeChangesRejected);
      add("Positioning change", callTypeSpecific.positioningChanges);
      add("Skill correction", callTypeSpecific.skillCorrections);
      add("Role targeting change", callTypeSpecific.roleTargetingChanges);
      break;
    case "orientation":
      add("Confusion point", callTypeSpecific.confusionPoints);
      add(
        "Application quality concern",
        callTypeSpecific.applicationQualityConcerns,
      );
      add("Targeting complaint", callTypeSpecific.targetingComplaints);
      add(
        "Immediate corrective action",
        callTypeSpecific.immediateCorrectiveActions,
      );
      break;
    case "progress":
      add("Working", callTypeSpecific.working);
      add("Not working", callTypeSpecific.notWorking);
      add("Complaint", callTypeSpecific.complaints);
      add("Strategy change", callTypeSpecific.strategyChanges);
      break;
    case "renewal":
      add("Value delivered", callTypeSpecific.valueDelivered);
      add("Unresolved problem", callTypeSpecific.unresolvedProblems);
      add("Objection", callTypeSpecific.objections);
      add("Churn risk evidence", callTypeSpecific.churnRiskEvidence);
      add("Next month strategy", callTypeSpecific.nextMonthStrategy);
      break;
  }

  return notes;
}

function formatUnknown(value: unknown) {
  if (value == null) return "None";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
