import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  getMeetingRecapData,
  type CallRecordRecapItem,
  type MeetingRecapData,
  type TranscriptSegmentData,
} from "@applywizz/domain/meeting-recap";
import {
  getMeetingOutcome,
  resolveMeetingOutcome,
  type MeetingOutcomeData,
} from "@applywizz/domain/meeting-outcome";
import { ConfirmRejectActions } from "@/components/customer-truth/confirm-reject-actions";
import { ResolveAction } from "@/components/actions/resolve-action";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { MediaPlayer } from "@/components/recap/media-player";

import styles from "./meeting-detail.module.css";
import { MeetingDetailTabs } from "./meeting-detail-tabs";
import { canViewRawTranscript as roleCanViewRawTranscript } from "./meeting-detail-access";
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

  const { data: speakerInterpretations } = await supabase
    .from("meeting_speaker_interpretations")
    .select("raw_speaker_tag, business_role, interpreted_name, confirmed_by_human")
    .eq("meeting_id", id);

  const speakerMap = new Map(
    (speakerInterpretations ?? []).map((si) => [
      si.raw_speaker_tag,
      {
        name: si.interpreted_name,
        role: si.business_role,
        confirmed: si.confirmed_by_human,
      },
    ]),
  );

  const { data: integrityReport } = await supabase
    .from("meeting_integrity_reports")
    .select("overall_verdict, summary, confidence_score_avg, suspected_background_media")
    .eq("meeting_id", id)
    .maybeSingle();

  const recapState = await getMeetingRecapData(supabase, id);
  let persistedOutcome = null;
  try {
    persistedOutcome = await getMeetingOutcome(supabase, id);
  } catch {
    persistedOutcome = null;
  }

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
  const canViewRawTranscript = roleCanViewRawTranscript(membership.roleKey);
  const recap = recapState?.status === "ready" ? recapState.recap : null;
  const outcome = resolveMeetingOutcome(persistedOutcome, recap);
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
  const needsReviewCount = (segmentRows ?? []).filter((s) => s.needs_review).length;

  const statusMeta = deriveStatusBadge(timeline);

  return (
    <div className={styles.root}>
      <div className={styles.backLinkWrap}>
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
                outcome={outcome}
                recap={recap}
                recapState={recapState}
                decisions={decisions}
                actions={actions}
                segmentById={segmentById}
                integrityReport={integrityReport}
                meetingId={id}
                meeting={meeting}
                botJob={botJob}
                isAdmin={isAdmin}
                canViewRawTranscript={canViewRawTranscript}
                needsReviewCount={needsReviewCount}
              />
            ),
          },
          {
            key: "audio",
            label: "Audio",
            content: (
              <AudioTab
                meetingId={id}
                botJob={botJob}
              />
            ),
          },
          {
            key: "video",
            label: "Video",
            content: (
              <VideoTab
                meetingId={id}
                botJob={botJob}
              />
            ),
          },
          // Transcript tab: Only visible to managers and admins, hidden from account_managers
          ...(canViewRawTranscript
            ? [
                {
                  key: "transcript",
                  label: "Transcript",
                  content: (
                    <TranscriptTab
                      segments={segmentRows ?? []}
                      transcript={transcript}
                      speakerMap={speakerMap}
                    />
                  ),
                },
              ]
            : []),
          {
            key: "insights",
            label: "Insights",
            content: (
              <InsightsTab
                actions={actions}
                decisions={decisions}
                truthDeltas={truthDeltas}
                segmentById={segmentById}
                openActionsCount={openActionsCount}
                pendingTruthCount={pendingTruthCount}
                integrityReport={integrityReport}
                meetingId={id}
                botJob={botJob}
                outcome={outcome}
                isAdmin={isAdmin}
                needsReviewCount={needsReviewCount}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------- Overview ----------

function OverviewTab({
  outcome,
  recap,
  recapState,
  decisions,
  actions,
  segmentById,
  integrityReport,
  meetingId,
  meeting,
  botJob,
  isAdmin,
  canViewRawTranscript,
  needsReviewCount,
}: {
  outcome: MeetingOutcomeData | null;
  recap: MeetingRecapData | null;
  recapState: Awaited<ReturnType<typeof getMeetingRecapData>>;
  decisions: CallRecordRecapItem[];
  actions: CallRecordRecapItem[];
  segmentById: Map<string, TranscriptSegmentData>;
  integrityReport?: {
    overall_verdict: string;
    summary: string;
    confidence_score_avg: number | null;
    suspected_background_media: boolean;
  } | null;
  meetingId?: string;
  meeting: { customer_id: string | null; organizer_name: string | null; organizer_email: string | null; scheduled_start: string; scheduled_end: string; provider: string };
  botJob: { status: string; last_error: string | null; provider: string; provider_bot_id: string | null; provider_metadata: unknown } | null;
  isAdmin: boolean;
  canViewRawTranscript: boolean;
  needsReviewCount: number;
}) {
  return (
    <div className={styles.body}>
      <div className={styles.main}>
        {/* Summary Card - prefer outcome, fallback to recap */}
        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Summary</span></div>
          <div className={styles.cardBody}>
            {outcome ? outcome.summary : recap ? recap.result.summary : <ProcessingNotice state={recapState} />}
          </div>
        </div>

        {/* Key Decisions - prefer outcome, fallback to recap */}
        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Key Decisions</span></div>
          {outcome ? (
            outcome.keyDecisions.length > 0 ? (
              <ul className={styles.list}>
                {outcome.keyDecisions.map((d, idx) => (
                  <li key={idx} className={styles.listItem}>
                    <div>
                      <div className={styles.listItemTitle}>{d.text}</div>
                      {firstEvidenceQuote(d.evidenceSegmentIds, segmentById)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>No key decisions were recorded.</p>
            )
          ) : recap ? (
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
              <p className={`${styles.cardBody} ${styles.muted}`}>No key decisions were recorded.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Available once analysis completes.</p>
          )}
        </div>

        {/* Action Items - prefer outcome, fallback to recap */}
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Action Items</span>
            {outcome && outcome.actionItems.length > 0 && <span className={styles.adminPill}>{outcome.actionItems.length}</span>}
            {!outcome && recap && actions.length > 0 && <span className={styles.adminPill}>{actions.length}</span>}
          </div>
          {outcome ? (
            outcome.actionItems.length > 0 ? (
              <ul className={styles.list}>
                {outcome.actionItems.map((a, idx) => (
                  <li key={idx} className={styles.listItem}>
                    <div>
                      <div className={styles.listItemTitle}>{a.description}</div>
                      <div className={styles.listItemMeta}>
                        {a.owner ? `Owner: ${a.owner}` : "Owner: Unassigned"}
                        {a.dueDate ? ` · Due ${formatDate(a.dueDate)}` : ""}
                      </div>
                      {firstEvidenceQuote(a.evidenceSegmentIds, segmentById)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>No action items were assigned.</p>
            )
          ) : recap ? (
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
              <p className={`${styles.cardBody} ${styles.muted}`}>No action items were assigned.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Actions will be extracted once analysis completes.</p>
          )}
        </div>

        <div className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>Open Questions</span>
            {outcome && outcome.openQuestions.filter((q) => q.status === "open").length > 0 && (
              <span className={styles.adminPill}>{outcome.openQuestions.filter((q) => q.status === "open").length}</span>
            )}
          </div>
          {outcome ? (
            outcome.openQuestions.length > 0 ? (
              <ul className={styles.list}>
                {outcome.openQuestions.map((q, idx) => (
                  <li key={idx} className={styles.listItem}>
                    <div style={{ flex: 1 }}>
                      <div className={styles.listItemTitle}>{q.question}</div>
                      {q.answer && (
                        <div className={styles.listItemMeta}>Answer: {q.answer}</div>
                      )}
                      {firstEvidenceQuote(q.evidenceSegmentIds, segmentById)}
                    </div>
                    <Badge tone={q.status === "open" ? "warning" : "success"}>{q.status === "open" ? "Open" : "Answered"}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${styles.cardBody} ${styles.muted}`}>All questions were resolved.</p>
            )
          ) : (
            <p className={`${styles.cardBody} ${styles.muted}`}>Available once analysis completes.</p>
          )}
        </div>
      </div>

      <div className={styles.side}>
        {/* Meeting Facts */}
        <div className={styles.card}>
          <div className={styles.cardHead}><span className={styles.cardTitle}>Meeting facts</span></div>
          <div className={styles.cardBody}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4 }}>Organizer</div>
              <div>{meeting.organizer_name ?? meeting.organizer_email ?? "—"}</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4 }}>When</div>
              <div>{formatMeetingDateTime(meeting.scheduled_start)}</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4 }}>Duration</div>
              <div>{formatDuration(meeting.scheduled_start, meeting.scheduled_end)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700, color: "var(--text-tertiary)", marginBottom: 4 }}>Platform</div>
              <div>{formatProvider(meeting.provider)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Transcript ----------

function TranscriptTab({
  segments,
  transcript,
  speakerMap,
}: {
  segments: { id: string; start_ms: number; end_ms: number; speaker_label: string; original_text: string; canonical_english_text: string | null; needs_review: boolean }[];
  transcript: { processing_status: string; detected_language: string | null } | null;
  speakerMap?: Map<string, { name: string | null; role: string; confirmed: boolean }>;
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

  return (
    <div className={styles.panelPad} style={{ maxWidth: 720 }}>
      {segments.map((segment) => (
        <TranscriptLine
          key={segment.id}
          id={segment.id}
          speaker={segment.speaker_label}
          interpretation={speakerMap?.get(segment.speaker_label)}
          text={segment.original_text}
          endMs={segment.end_ms}
          needsReview={segment.needs_review}
        />
      ))}
    </div>
  );
}

// ---------- Audio ----------

function AudioTab({
  meetingId,
  botJob,
}: {
  meetingId: string;
  botJob: { status: string } | null;
}) {
  if (botJob?.status !== "completed") {
    return (
      <div className={styles.emptyState}>
        {botJob?.status === "failed"
          ? "Recording failed or was cancelled."
          : "Recording will appear when available."}
      </div>
    );
  }

  return (
    <div className={styles.panelPad}>
      <MediaPlayer meetingId={meetingId} />
    </div>
  );
}

// ---------- Video ----------

function VideoTab({
  meetingId,
  botJob,
}: {
  meetingId: string;
  botJob: { status: string } | null;
}) {
  if (botJob?.status !== "completed") {
    return (
      <div className={styles.emptyState}>
        {botJob?.status === "failed"
          ? "Recording failed or was cancelled."
          : "Video will appear when available."}
      </div>
    );
  }

  return (
    <div className={styles.panelPad}>
      <MediaPlayer meetingId={meetingId} />
      <p className={styles.muted} style={{ marginTop: 12, fontSize: 12 }}>
        Note: Video is shown when screen recording is available. Audio-only meetings will show the audio player.
      </p>
    </div>
  );
}

// ---------- Insights ----------

function InsightsTab({
  actions,
  decisions,
  truthDeltas,
  segmentById,
  openActionsCount,
  pendingTruthCount,
  integrityReport,
  meetingId,
  botJob,
  outcome,
  isAdmin,
  needsReviewCount,
}: {
  actions: CallRecordRecapItem[];
  decisions: CallRecordRecapItem[];
  truthDeltas: MeetingRecapData["result"]["customerTruthDeltas"];
  segmentById: Map<string, TranscriptSegmentData>;
  openActionsCount: number;
  pendingTruthCount: number;
  integrityReport?: {
    overall_verdict: string;
    summary: string;
    confidence_score_avg: number | null;
    suspected_background_media: boolean;
  } | null;
  meetingId: string;
  botJob: { status: string; last_error: string | null; provider: string; provider_bot_id: string | null; provider_metadata: unknown } | null;
  outcome: MeetingOutcomeData | null;
  isAdmin: boolean;
  needsReviewCount: number;
}) {
  return (
    <div className={styles.panelPad}>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Quality & Transcript Health */}
        {(integrityReport && integrityReport.overall_verdict !== "good") || needsReviewCount > 0 ? (
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>
              Quality & Transcript Health
            </h3>
            {integrityReport && integrityReport.overall_verdict !== "good" && (
              <div
                className={styles.card}
                style={{
                  borderColor:
                    integrityReport.overall_verdict === "transcription_unreliable" ||
                    integrityReport.overall_verdict === "poor_audio"
                      ? "var(--critical)"
                      : "var(--warning)",
                  backgroundColor:
                    integrityReport.overall_verdict === "transcription_unreliable" ||
                    integrityReport.overall_verdict === "poor_audio"
                      ? "var(--critical-tint)"
                      : "var(--warning-tint)",
                }}
              >
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span>Quality Alert</span>
                    <Badge
                      tone={
                        integrityReport.overall_verdict === "transcription_unreliable" ||
                        integrityReport.overall_verdict === "poor_audio"
                          ? "critical"
                          : "warning"
                      }
                    >
                      {integrityReport.overall_verdict}
                    </Badge>
                  </span>
                  {integrityReport.confidence_score_avg != null && (
                    <span className={styles.muted} style={{ fontSize: 12 }}>
                      Confidence: {Math.round(integrityReport.confidence_score_avg * 100)}%
                    </span>
                  )}
                </div>
                <div className={styles.cardBody}>
                  <p style={{ margin: 0, fontSize: 13 }}>{integrityReport.summary}</p>
                </div>
              </div>
            )}
            {needsReviewCount > 0 && (
              <div className={styles.card} style={{ marginTop: 12 }}>
                <div className={styles.cardHead}>
                  <span className={styles.cardTitle}>Transcript Review</span>
                  <Badge tone="warning">{needsReviewCount} segments</Badge>
                </div>
                <div className={styles.cardBody}>
                  <Link href={`/meetings/${meetingId}?tab=transcript`} style={{ color: "var(--accent)" }}>
                    View transcript segments that need review &rarr;
                  </Link>
                </div>
              </div>
            )}
          </div>
        ) : null}
        {/* Actions Section */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>
            Actions & Decisions ({openActionsCount} open)
          </h3>
          {actions.length > 0 || decisions.length > 0 ? (
            <div className={styles.list}>
              {[...actions, ...decisions.filter((d) => d.status === "detected")].map((item) => (
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
          ) : (
            <p className={styles.muted}>No actions or decisions tracked.</p>
          )}
        </div>

        {/* Customer Truth Section */}
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>
            Customer Truth Updates ({pendingTruthCount} pending)
          </h3>
          {truthDeltas.length > 0 ? (
            <div className={styles.list}>
              {truthDeltas.map((delta) => (
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
          ) : (
            <p className={styles.muted}>No customer truth updates from this meeting.</p>
          )}
        </div>

        {/* Admin Technical Details */}
        {isAdmin && (
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, color: "var(--text)" }}>
              Technical Details
              <span className={styles.adminPill} style={{ marginLeft: 8 }}>Admin</span>
            </h3>
            <div className={styles.card}>
              <div className={styles.technicalDetails}>
                bot_status: {botJob?.status ?? "none"}
                <br />
                provider: {botJob?.provider ?? "—"}
                <br />
                provider_bot_id: {botJob?.provider_bot_id ?? "—"}
                <br />
                {botJob?.last_error ? <>last_error: {botJob.last_error}<br /></> : null}
                {outcome && (
                  <>
                    outcome_model: {outcome.model}
                    <br />
                    outcome_generated: {formatDateTime(outcome.generatedAt)}
                    <br />
                  </>
                )}
              </div>
            </div>
          </div>
        )}
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

function TranscriptLine({
  id,
  speaker,
  interpretation,
  text,
  endMs,
  needsReview,
}: {
  id?: string;
  speaker: string;
  interpretation?: { name: string | null; role: string; confirmed: boolean };
  text: string;
  endMs: number;
  needsReview?: boolean;
}) {
  const rawTag = speaker === "speaker_unknown" ? "Unknown speaker" : speaker;
  const roleDisplay =
    interpretation?.role && interpretation.role !== "UNKNOWN"
      ? ` (${interpretation.role})`
      : "";
  const displayName = interpretation?.name
    ? `${interpretation.name}${roleDisplay}`
    : rawTag;

  return (
    <div
      id={id ? `segment-${id}` : undefined}
      className={styles.transcriptLine}
    >
      <div className={styles.avatar}>{displayName.charAt(0).toUpperCase()}</div>
      <div style={{ flex: 1 }}>
        <span className={styles.who}>
          {displayName}
          {interpretation?.name && (
            <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 6, fontWeight: "normal" }}>
              [{rawTag}]
            </span>
          )}
          <span className={styles.when}>{formatTimestamp(endMs)}</span>
          {needsReview ? (
            <span className={styles.adminPill} style={{ marginLeft: 8, color: "var(--warning)" }}>
              Needs Review
            </span>
          ) : null}
        </span>
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

function formatMeetingDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { 
    month: "short", 
    day: "numeric", 
    year: "numeric",
    hour: "numeric", 
    minute: "2-digit" 
  }).format(new Date(value));
}

function formatDuration(start: string, end: string) {
  const minutes = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
  return `${minutes} minutes`;
}
