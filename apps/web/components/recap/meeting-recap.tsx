"use client";

import { useState } from "react";
import Link from "next/link";

// Codex Pass 2 (NIT, fixed): import the real contract type directly from
// where it's defined, not through the fixture module's type-only re-export.
import type {
  MeetingRecapData,
  TranscriptSegmentData,
} from "@applywizz/domain/meeting-recap";
import { StatusBadge, type BadgeTone } from "../admin/status-badge";
import { ResolveAction } from "../actions/resolve-action";
import { ConfirmRejectActions } from "../customer-truth/confirm-reject-actions";
import { CustomerSafeRecapSection } from "./customer-safe-recap";
import { MediaPlayer } from "./media-player";
import { MeetingIntegrityCard } from "./meeting-integrity-card";

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

const CALL_RECORD_STATUS_LABELS: Record<string, string> = {
  detected: "Needs review",
  completed: "Completed",
  cancelled: "Dismissed",
};

const CALL_RECORD_STATUS_TONE: Record<string, BadgeTone> = {
  detected: "warning",
  completed: "success",
  cancelled: "neutral",
};

const TRUTH_STATUS_LABELS: Record<string, string> = {
  proposed: "Needs review",
  confirmed: "Confirmed",
  rejected: "Rejected",
  superseded: "Superseded",
};

const TRUTH_STATUS_TONE: Record<string, BadgeTone> = {
  proposed: "warning",
  confirmed: "success",
  rejected: "critical",
  superseded: "neutral",
};

export function MeetingRecap({
  recap,
  canEdit = true,
}: {
  recap: MeetingRecapData;
  canEdit?: boolean;
}) {
  const [seekMs, setSeekMs] = useState<number | null>(null);
  const [currentPlaybackMs, setCurrentPlaybackMs] = useState<number>(0);

  const handleSeek = (ms: number) => {
    setSeekMs(ms);
  };

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
            <Link
              href={`/admin/meetings/${recap.id}`}
              className="rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              View Meeting
            </Link>
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

      {/* Audio Player */}
      <MediaPlayer
        meetingId={recap.id}
        recordingUrl={recap.recordingUrl}
        externalSeekMs={seekMs}
        onTimeUpdate={setCurrentPlaybackMs}
      />

      {/* Conversational Integrity & Talk Ratio */}
      {recap.integrityReport && (
        <MeetingIntegrityCard
          integrity={recap.integrityReport}
          onSeek={handleSeek}
        />
      )}

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
        {recap.result.customerTruthDeltas.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
            No changes detected in this call.
          </p>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {recap.result.customerTruthDeltas.map((delta) => (
              <EvidenceItem
                key={delta.id ?? delta.fieldKey}
                title={humanize(delta.fieldKey)}
                meta={`Confidence ${Math.round(delta.confidence * 100)}%`}
                evidenceSegmentIds={delta.evidenceSegmentIds}
                segmentById={segmentById}
                onSeek={handleSeek}
                currentPlaybackMs={currentPlaybackMs}
                badge={
                  delta.noChange ? (
                    <StatusBadge tone="neutral">No change</StatusBadge>
                  ) : delta.status ? (
                    <StatusBadge
                      tone={TRUTH_STATUS_TONE[delta.status] ?? "neutral"}
                    >
                      {TRUTH_STATUS_LABELS[delta.status] ?? delta.status}
                    </StatusBadge>
                  ) : null
                }
                action={
                  delta.id && delta.status === "proposed" && !delta.noChange ? (
                    <ConfirmRejectActions factId={delta.id} />
                  ) : null
                }
              >
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <ValueBlock label="Previous" value={delta.previousValue} />
                  <ValueBlock label="Proposed" value={delta.proposedValue} />
                </div>
              </EvidenceItem>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <RecordSection
          title="Actions"
          records={actions}
          segmentById={segmentById}
          onSeek={handleSeek}
          currentPlaybackMs={currentPlaybackMs}
        />
        <RecordSection
          title="Commitments"
          records={commitments}
          segmentById={segmentById}
          onSeek={handleSeek}
          currentPlaybackMs={currentPlaybackMs}
        />
      </div>

      <RecordSection
        title="Missing Info / Blockers"
        records={blockers}
        segmentById={segmentById}
        emptyText="No missing information or blockers detected."
        onSeek={handleSeek}
        currentPlaybackMs={currentPlaybackMs}
      />

      {recap.customerSafeRecap ? (
        <CustomerSafeRecapSection
          meetingId={recap.id}
          recap={recap.customerSafeRecap}
          canEdit={canEdit}
        />
      ) : null}

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
                onSeek={handleSeek}
                currentPlaybackMs={currentPlaybackMs}
              />
            ))}
          </div>
        </section>
      )}

      {/* Full Synchronized Transcript */}
      {recap.transcriptSegments.length > 0 && (
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
          <details className="group">
            <summary className="cursor-pointer list-none border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">
                  Full Transcript ({recap.transcriptSegments.length} segments)
                </h2>
                <span className="text-xs text-zinc-400 group-open:hidden">
                  Expand
                </span>
                <span className="hidden text-xs text-zinc-400 group-open:inline">
                  Collapse
                </span>
              </div>
            </summary>
            <div className="flex flex-col gap-2 p-4 max-h-[450px] overflow-y-auto">
              {recap.transcriptSegments.map((segment) => {
                const isActive =
                  currentPlaybackMs >= segment.startMs &&
                  currentPlaybackMs <= segment.endMs;
                return (
                  <TranscriptSegment
                    key={segment.id}
                    segment={segment}
                    onSeek={handleSeek}
                    isActive={isActive}
                  />
                );
              })}
            </div>
          </details>
        </section>
      )}

      <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-medium">Ask Signal</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Placeholder for M13. Ask Signal is not available yet — no retrieval,
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
  emptyText = "Nothing detected.",
  onSeek,
  currentPlaybackMs,
}: {
  title: string;
  records: MeetingRecapData["result"]["callRecords"];
  segmentById: Map<string, TranscriptSegmentData>;
  emptyText?: string;
  onSeek?: (ms: number) => void;
  currentPlaybackMs?: number;
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
              key={record.id ?? `${record.recordType}-${record.description}`}
              title={record.description}
              meta={`${RECORD_TYPE_LABELS[record.recordType]} · ${ownerLabel(record)}${
                record.dueAt ? ` · Due ${formatDate(record.dueAt)}` : ""
              }`}
              evidenceSegmentIds={record.evidenceSegmentIds}
              segmentById={segmentById}
              onSeek={onSeek}
              currentPlaybackMs={currentPlaybackMs}
              badge={
                record.status ? (
                  <StatusBadge
                    tone={CALL_RECORD_STATUS_TONE[record.status] ?? "neutral"}
                  >
                    {CALL_RECORD_STATUS_LABELS[record.status] ?? record.status}
                  </StatusBadge>
                ) : null
              }
              action={
                record.id && record.status === "detected" ? (
                  <ResolveAction recordId={record.id} />
                ) : null
              }
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
  badge,
  action,
  children,
  onSeek,
  currentPlaybackMs,
}: {
  title: string;
  meta: string;
  evidenceSegmentIds: string[];
  segmentById: Map<string, TranscriptSegmentData>;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children?: React.ReactNode;
  onSeek?: (ms: number) => void;
  currentPlaybackMs?: number;
}) {
  return (
    <div className="px-4 py-3">
      <details className="group">
        <summary className="cursor-pointer list-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{title}</p>
                {badge}
              </div>
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

              const isActive =
                currentPlaybackMs != null &&
                currentPlaybackMs >= segment.startMs &&
                currentPlaybackMs <= segment.endMs;

              return (
                <TranscriptSegment
                  key={id}
                  segment={segment}
                  onSeek={onSeek}
                  isActive={isActive}
                />
              );
            })}
          </div>
        </div>
      </details>
      {action ? <div className="mt-2 flex justify-end">{action}</div> : null}
    </div>
  );
}

function TranscriptSegment({
  segment,
  onSeek,
  isActive,
}: {
  segment: TranscriptSegmentData;
  onSeek?: (ms: number) => void;
  isActive?: boolean;
}) {
  return (
    <div
      className={`rounded-md p-3 transition ${
        isActive
          ? "bg-indigo-50 border border-indigo-200 dark:bg-indigo-950/40 dark:border-indigo-800"
          : "bg-zinc-50 dark:bg-zinc-950"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
        {onSeek ? (
          <button
            type="button"
            onClick={() => onSeek(segment.startMs)}
            className="font-mono hover:text-indigo-600 hover:underline cursor-pointer"
            title="Click to jump audio here"
          >
            {formatTimestamp(segment.startMs)}-{formatTimestamp(segment.endMs)}
          </button>
        ) : (
          <span className="font-mono">
            {formatTimestamp(segment.startMs)}-{formatTimestamp(segment.endMs)}
          </span>
        )}
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

function ownerLabel(record: MeetingRecapData["result"]["callRecords"][number]) {
  return `${humanize(record.ownerType)}${record.ownerRef ? `: ${record.ownerRef}` : ""}`;
}

type RecapClaim = { text: string; evidenceSegmentIds: string[] };

function getCallSpecificNotes(recap: MeetingRecapData) {
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
