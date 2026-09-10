import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  getMeetingRecapData,
  type CallRecordRecapItem,
  type MeetingRecapData,
  type TranscriptSegmentData,
} from "@applywizz/domain/meeting-recap";
import { ConfirmRejectActions } from "@/components/customer-truth/confirm-reject-actions";
import { ResolveAction } from "@/components/actions/resolve-action";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

import styles from "./meeting-detail.module.css";
import { MeetingDetailTabs } from "./meeting-detail-tabs";
import { computeProcessingTimeline, type TimelineStep } from "./timeline";

/**
 * Meeting Detail — the single-source-of-truth screen for one meeting.
 * Replaces the two-page split (/admin/meetings/[id] for the transcript,
 * /meetings/[id]/recap for the intelligence) with one page, tabbed.
 *
 * Reuses the exact same data source and mutation components the two old
 * pages already used (getMeetingRecapData, ConfirmRejectActions,
 * ResolveAction) — this page changes presentation only, never the
 * underlying queries or the confirm/reject/resolve API routes.
 */
export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const membership = await requireRole([
    "account_manager",
    "manager",
    "senior_manager",
    "admin",
  ]);
  const supabase = await getSupabaseServerClient();
  const { id } = await params;

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select(
      "id, title, organizer_name, organizer_email, scheduled_start, scheduled_end, lifecycle_status, provider, created_at, customer_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (meetingError) throw meetingError;
  if (!meeting) notFound();

  // A meeting can have more than one meeting_bot_jobs row (retries,
  // duplicate-dispatch artifacts) — the most RECENT row is not necessarily
  // the one that actually recorded the meeting. Prefer a real completed
  // session over a later failed/cancelled retry; only fall back to "most
  // recent" when nothing ever completed, so an in-progress meeting still
  // shows its current live state.
  const { data: botJobs, error: botJobError } = await supabase
    .from("meeting_bot_jobs")
    .select(
      "status, joined_at, left_at, cancelled_at, failed_at, last_error, provider, provider_bot_id, provider_metadata",
    )
    .eq("meeting_id", id)
    .order("created_at", { ascending: false });
  if (botJobError) throw botJobError;
  const botJob =
    (botJobs ?? []).find((job) => job.status === "completed") ??
    (botJobs ?? [])[0] ??
    null;

  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select(
      "id, processing_status, error_code, completed_at, detected_language, model",
    )
    .eq("meeting_id", id)
    .maybeSingle();
  if (transcriptError) throw transcriptError;

  const { data: segmentRows, error: segmentsError } = transcript
    ? await supabase
        .from("transcript_segments")
        .select(
          "id, sequence_index, start_ms, end_ms, original_text, canonical_english_text, speaker_label, needs_review",
        )
        .eq("transcript_id", transcript.id)
        .order("sequence_index", { ascending: true })
    : { data: [], error: null };
  if (segmentsError) throw segmentsError;

  const { data: lifecycleEvents, error: eventsError } = await supabase
    .from("meeting_lifecycle_events")
    .select("id, event_type, occurred_at, source")
    .eq("meeting_id", id)
    .order("occurred_at", { ascending: false });
  if (eventsError) throw eventsError;

  const recapState = await getMeetingRecapData(supabase, id);

  const intelligenceStatus =
    recapState?.status === "ready"
      ? "ready"
      : recapState?.status === "intelligence_failed"
        ? "failed"
        : recapState?.status === "intelligence_not_ready"
          ? "not_ready"
          : "unknown";

  const timeline = computeProcessingTimeline({
    meetingCreatedAt: meeting.created_at,
    botJob: botJob
      ? {
          status: botJob.status,
          joinedAt: botJob.joined_at,
          leftAt: botJob.left_at,
          cancelledAt: botJob.cancelled_at,
          failedAt: botJob.failed_at,
        }
      : null,
    transcript: transcript
      ? {
          processingStatus: transcript.processing_status,
          completedAt: transcript.completed_at,
        }
      : null,
    intelligenceStatus,
  });

  const isAdmin = membership.roleKey === "admin";
  const recap = recapState?.status === "ready" ? recapState.recap : null;
  const segmentById = new Map(
    (segmentRows ?? []).map((s) => [
      s.id,
      {
        id: s.id,
        startMs: s.start_ms,
        endMs: s.end_ms,
        speakerLabel: s.speaker_label,
        originalText: s.original_text,
        canonicalEnglishText: s.canonical_english_text ?? s.original_text,
      } satisfies TranscriptSegmentData,
    ]),
  );

  const decisions = recap?.result.callRecords.filter((r) => r.recordType === "decision") ?? [];
  const actions = recap?.result.callRecords.filter((r) => r.recordType === "action_item") ?? [];
  const openActionsCount = actions.filter((a) => a.status === "detected").length;
  const truthDeltas = recap?.result.customerTruthDeltas.filter((d) => !d.noChange) ?? [];
  const pendingTruthCount = truthDeltas.filter((d) => d.status === "proposed").length;

  const statusMeta = deriveStatusBadge(timeline);

  return (
    <div className={styles.root}>
      <div style={{ padding: "14px 28px 0" }}>
        <Link href="/admin/meetings" className={styles.backLink}>
          &larr; All meetings
        </Link>
      </div>

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>{meeting.title}</h1>
          <div className={styles.meta}>
            <span>{formatProvider(meeting.provider)}</span>
            <span>{formatRange(meeting.scheduled_start, meeting.scheduled_end)}</span>
            <span>{meeting.organizer_name ?? meeting.organizer_email ?? "Organizer unknown"}</span>
            {recap && recap.customer.name !== "Unlinked meeting" ? (
              <span>{recap.customer.name}</span>
            ) : null}
          </div>
        </div>
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
      </div>

      <div className={styles.timeline}>
        {timeline.map((step) => (
          <TimelineDot key={step.key} step={step} />
        ))}
      </div>

      <MeetingDetailTabs
        tabs={[
          {
            key: "overview",
            label: "Overview",
            content: (
              <OverviewTab
                recap={recap}
                recapState={recapState}
                decisions={decisions}
                actions={actions}
                truthDeltas={truthDeltas}
                segmentById={segmentById}
                previewSegments={(segmentRows ?? []).slice(0, 2)}
                meeting={meeting}
                botJob={botJob}
                isAdmin={isAdmin}
              />
            ),
          },
          {
            key: "transcript",
            label: "Transcript",
            content: (
              <TranscriptTab
                segments={segmentRows ?? []}
                transcript={transcript}
              />
            ),
          },
          {
            key: "actions",
            label: "Actions",
            count: openActionsCount,
            content: (
              <ActionsTab actions={actions} decisions={decisions} segmentById={segmentById} />
            ),
          },
          {
            key: "customer-truth",
            label: "Customer Truth",
            count: pendingTruthCount,
            content: <CustomerTruthTab deltas={truthDeltas} segmentById={segmentById} />,
          },
          {
            key: "activity",
            label: "Activity",
            content: <ActivityTab events={lifecycleEvents ?? []} />,
          },
        ]}
      />
    </div>
  );
}

// ---------- Overview ----------

function OverviewTab({
  recap,
  recapState,
  decisions,
  actions,
  truthDeltas,
  segmentById,
  previewSegments,
  meeting,
  botJob,
  isAdmin,
}: {
  recap: MeetingRecapData | null;
  recapState: Awaited<ReturnType<typeof getMeetingRecapData>>;
  decisions: CallRecordRecapItem[];
  actions: CallRecordRecapItem[];
  truthDeltas: MeetingRecapData["result"]["customerTruthDeltas"];
  segmentById: Map<string, TranscriptSegmentData>;
  previewSegments: { id: string; speaker_label: string; original_text: string; end_ms: number }[];
  meeting: { organizer_name: string | null; organizer_email: string | null; scheduled_start: string; scheduled_end: string; provider: string };
  botJob: { status: string; last_error: string | null; provider: string; provider_bot_id: string | null; provider_metadata: unknown } | null;
  isAdmin: boolean;
}) {
  return (
    <div className={styles.body}>
      <div className={styles.main}>
        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>AI Summary</span></div>
          <div className={styles.cardBody}>
            {recap ? recap.result.summary : <ProcessingNotice state={recapState} />}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Key Decisions</span></div>
          {recap ? (
            decisions.length > 0 ? (
              <ul className={styles.list}>
                {decisions.map((d) => (
                  <li key={d.id ?? d.description} className={styles.listItem}>
                    <div>
                      <div className={styles.listItemTitle}>{d.description}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>No decisions detected in this call.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Available once analysis completes.</p>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Next Steps</span>
          </div>
          <div className={styles.cardBody}>
            {recap ? recap.nextJourneyStep : <ProcessingNotice state={recapState} />}
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Actions</span>
            {recap ? <span className={styles.adminPill}>{actions.length}</span> : null}
          </div>
          {recap ? (
            actions.length > 0 ? (
              <ul className={styles.list}>
                {actions.slice(0, 4).map((a) => (
                  <li key={a.id ?? a.description} className={styles.listItem}>
                    <div>
                      <div className={styles.listItemTitle}>{a.description}</div>
                      <div className={styles.listItemMeta}>
                        {ownerLabel(a)}
                        {a.dueAt ? ` · Due ${formatDate(a.dueAt)}` : ""}
                      </div>
                    </div>
                    {a.status ? <Badge tone={a.status === "detected" ? "warning" : "success"}>{a.status === "detected" ? "Open" : "Resolved"}</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>No action items detected.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Actions will be extracted once analysis completes.</p>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Customer Truth Proposals</span>
          </div>
          {recap ? (
            truthDeltas.length > 0 ? (
              <div className={styles.list}>
                {truthDeltas.slice(0, 3).map((delta) => (
                  <div key={delta.id ?? delta.fieldKey} className={styles.listItem}>
                    <div style={{ flex: 1 }}>
                      <div className={styles.listItemMeta} style={{ textTransform: "capitalize" }}>{delta.fieldKey.replaceAll("_", " ")}</div>
                      <div className={styles.truthRow}>
                        <span className={styles.truthOld}>{formatValue(delta.previousValue)}</span>
                        <span>&rarr;</span>
                        <span className={styles.truthNew}>{formatValue(delta.proposedValue)}</span>
                      </div>
                      {firstEvidenceQuote(delta.evidenceSegmentIds, segmentById)}
                    </div>
                    {delta.id && delta.status === "proposed" ? <ConfirmRejectActions factId={delta.id} /> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>No customer truth proposals yet. AI will suggest updates when this call supports one.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Available once analysis completes.</p>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Transcript Preview</span>
          </div>
          {previewSegments.length > 0 ? (
            <>
              {previewSegments.map((s) => (
                <TranscriptLine key={s.id} speaker={s.speaker_label} text={s.original_text} endMs={s.end_ms} />
              ))}
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--accent)" }}>View full transcript in the Transcript tab &rarr;</div>
            </>
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Transcript will appear here once the recording is processed.</p>
          )}
        </div>
      </div>

      <div className={styles.side}>
        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Meeting Details</span></div>
          <div className={styles.cardBody}>
            <div>{meeting.organizer_name ?? meeting.organizer_email ?? "—"} · Organizer</div>
            <div className={styles.muted}>{formatRange(meeting.scheduled_start, meeting.scheduled_end)}</div>
            <div className={styles.muted}>{formatProvider(meeting.provider)}</div>
          </div>
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Recording</span></div>
          <div className={styles.cardBody}>
            {botJob?.status === "completed" ? "Available" : botJob ? "Not available yet" : "Not requested for this meeting"}
          </div>
        </div>

        {isAdmin ? (
          <div className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.cardTitle}>Technical Details</span>
              <span className={styles.adminPill}>Admin</span>
            </div>
            <div className={styles.technicalDetails}>
              bot_status: {botJob?.status ?? "none"}
              <br />
              provider: {botJob?.provider ?? "—"}
              <br />
              provider_bot_id: {botJob?.provider_bot_id ?? "—"}
              <br />
              {botJob?.last_error ? <>last_error: {botJob.last_error}<br /></> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------- Transcript ----------

function TranscriptTab({
  segments,
  transcript,
}: {
  segments: { id: string; start_ms: number; end_ms: number; speaker_label: string; original_text: string; canonical_english_text: string | null; needs_review: boolean }[];
  transcript: { processing_status: string; detected_language: string | null } | null;
}) {
  if (!transcript) {
    return <div className={styles.emptyState}>No transcript for this meeting yet.</div>;
  }
  if (segments.length === 0) {
    return (
      <div className={styles.emptyState}>
        {transcript.processing_status === "completed"
          ? "This meeting had no transcribable speech."
          : "Transcript is still processing."}
      </div>
    );
  }

  const grouped = groupConsecutiveBySpeaker(segments);

  return (
    <div className={styles.panelPad} style={{ maxWidth: 720 }}>
      {grouped.map((group) => {
        // Groups are only ever created with at least one segment (see
        // groupConsecutiveBySpeaker below), so these are always defined.
        const first = group.segments[0]!;
        const last = group.segments[group.segments.length - 1]!;
        return (
          <TranscriptLine
            key={first.id}
            speaker={group.speaker}
            text={group.segments.map((s) => s.original_text).join(" ")}
            endMs={last.end_ms}
          />
        );
      })}
    </div>
  );
}

function groupConsecutiveBySpeaker<T extends { speaker_label: string }>(segments: T[]) {
  const groups: { speaker: string; segments: T[] }[] = [];
  for (const segment of segments) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === segment.speaker_label) {
      last.segments.push(segment);
    } else {
      groups.push({ speaker: segment.speaker_label, segments: [segment] });
    }
  }
  return groups;
}

// ---------- Actions ----------

function ActionsTab({
  actions,
  decisions,
  segmentById,
}: {
  actions: CallRecordRecapItem[];
  decisions: CallRecordRecapItem[];
  segmentById: Map<string, TranscriptSegmentData>;
}) {
  const items = [...actions, ...decisions.filter((d) => d.status === "detected")];
  if (items.length === 0) {
    return <div className={styles.emptyState}>Nothing outstanding for this meeting.</div>;
  }
  return (
    <div className={styles.panelPad}>
      <div className={styles.list}>
        {items.map((item) => (
          <div key={item.id ?? item.description} className={styles.listItem}>
            <div style={{ flex: 1 }}>
              <div className={styles.listItemTitle}>{item.description}</div>
              <div className={styles.listItemMeta}>
                {item.recordType === "action_item" ? "Action" : "Decision"} · {ownerLabel(item)}
                {item.dueAt ? ` · Due ${formatDate(item.dueAt)}` : ""}
              </div>
              {firstEvidenceQuote(item.evidenceSegmentIds, segmentById)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              {item.status ? <Badge tone={item.status === "detected" ? "warning" : "success"}>{item.status === "detected" ? "Open" : "Resolved"}</Badge> : null}
              {item.id && item.status === "detected" ? <ResolveAction recordId={item.id} /> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Customer Truth ----------

function CustomerTruthTab({
  deltas,
  segmentById,
}: {
  deltas: MeetingRecapData["result"]["customerTruthDeltas"];
  segmentById: Map<string, TranscriptSegmentData>;
}) {
  if (deltas.length === 0) {
    return <div className={styles.emptyState}>No Customer Truth proposals from this meeting.</div>;
  }
  return (
    <div className={styles.panelPad}>
      <div className={styles.list}>
        {deltas.map((delta) => (
          <div key={delta.id ?? delta.fieldKey} className={styles.listItem}>
            <div style={{ flex: 1 }}>
              <div className={styles.listItemTitle} style={{ textTransform: "capitalize" }}>{delta.fieldKey.replaceAll("_", " ")}</div>
              <div className={styles.truthRow}>
                <span className={styles.truthOld}>{formatValue(delta.previousValue)}</span>
                <span>&rarr;</span>
                <span className={styles.truthNew}>{formatValue(delta.proposedValue)}</span>
              </div>
              {firstEvidenceQuote(delta.evidenceSegmentIds, segmentById)}
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              {delta.status ? (
                <Badge tone={delta.status === "proposed" ? "warning" : delta.status === "confirmed" ? "success" : "neutral"}>
                  {delta.status === "proposed" ? "Awaiting review" : delta.status}
                </Badge>
              ) : null}
              {delta.id && delta.status === "proposed" ? <ConfirmRejectActions factId={delta.id} /> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Activity ----------

function ActivityTab({ events }: { events: { id: string; event_type: string; occurred_at: string; source: string }[] }) {
  if (events.length === 0) {
    return <div className={styles.emptyState}>No activity recorded yet.</div>;
  }
  return (
    <div className={styles.panelPad}>
      <div className={styles.list}>
        {events.map((event) => (
          <div key={event.id} className={styles.listItem}>
            <div>
              <div className={styles.listItemTitle}>{humanizeEventType(event.event_type)}</div>
              <div className={styles.listItemMeta}>{event.source} · {formatDateTime(event.occurred_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Shared bits ----------

function ProcessingNotice({ state }: { state: Awaited<ReturnType<typeof getMeetingRecapData>> }) {
  if (!state || state.status === "transcript_processing") {
    return <span className={styles.muted}>Transcript is still processing.</span>;
  }
  if (state.status === "transcript_failed") {
    return <span className={styles.muted}>Transcription failed{state.errorCode ? ` (${state.errorCode})` : ""}.</span>;
  }
  if (state.status === "intelligence_not_ready") {
    return <span className={styles.muted}>Analysis is still running.</span>;
  }
  if (state.status === "intelligence_failed") {
    return <span className={styles.muted}>Analysis failed{state.errorCode ? ` (${state.errorCode})` : ""}.</span>;
  }
  return null;
}

function TimelineDot({ step }: { step: TimelineStep }) {
  const cls = [
    styles.tlStep,
    step.state === "done" ? styles.tlDone : "",
    step.state === "active" ? styles.tlActive : "",
    step.state === "failed" ? styles.tlFailed : "",
    step.state === "skipped" ? styles.tlSkipped : "",
    step.state === "pending" ? styles.tlPending : "",
  ].join(" ");
  const icon = step.state === "done" ? "✓" : step.state === "failed" ? "!" : "";
  return (
    <div className={cls}>
      <div className={styles.tlDot}>{icon}</div>
      <div className={styles.tlLabel}>{step.label}</div>
      {step.at ? <div className={styles.tlTime}>{formatTime(step.at)}</div> : null}
    </div>
  );
}

function TranscriptLine({ speaker, text, endMs }: { speaker: string; text: string; endMs: number }) {
  const displayName = speaker === "speaker_unknown" ? "Unknown speaker" : speaker;
  return (
    <div className={styles.transcriptLine}>
      <div className={styles.avatar}>{displayName.charAt(0).toUpperCase()}</div>
      <div>
        <span className={styles.who}>{displayName}<span className={styles.when}>{formatTimestamp(endMs)}</span></span>
        <div className={styles.transcriptText}>{text}</div>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "success" | "warning" | "critical" | "info" | "neutral"; children: ReactNode }) {
  const toneClass = {
    success: styles.badgeSuccess,
    warning: styles.badgeWarning,
    critical: styles.badgeCritical,
    info: styles.badgeInfo,
    neutral: styles.badgeNeutral,
  }[tone];
  return <span className={`${styles.badge} ${toneClass}`}>{children}</span>;
}

function deriveStatusBadge(timeline: TimelineStep[]): { label: string; tone: "success" | "warning" | "critical" | "info" | "neutral" } {
  if (timeline.some((s) => s.state === "failed")) return { label: "Failed", tone: "critical" };
  const analysis = timeline.find((s) => s.key === "analysis");
  if (analysis?.state === "done") return { label: "Complete", tone: "success" };
  if (timeline.some((s) => s.state === "active")) return { label: "In progress", tone: "info" };
  return { label: "Pending", tone: "neutral" };
}

function firstEvidenceQuote(ids: string[], segmentById: Map<string, TranscriptSegmentData>) {
  const first = ids.map((id) => segmentById.get(id)).find(Boolean);
  if (!first) return null;
  return <div className={styles.evidenceQuote}>&ldquo;{truncate(first.originalText, 140)}&rdquo;</div>;
}

function ownerLabel(record: CallRecordRecapItem) {
  return `${record.ownerType.replaceAll("_", " ")}${record.ownerRef ? `: ${record.ownerRef}` : ""}`;
}

function formatValue(value: unknown) {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function formatProvider(provider: string) {
  if (provider === "microsoft") return "Microsoft Teams";
  return provider;
}

function formatRange(start: string, end: string) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const dateLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(startDate);
  const startLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(startDate);
  const endLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(endDate);
  const minutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);
  return `${dateLabel} · ${startLabel}–${endLabel} · ${minutes} min`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function humanizeEventType(eventType: string) {
  return eventType.replaceAll(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
