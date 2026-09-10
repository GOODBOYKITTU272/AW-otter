import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

export type IntegrityVerdict =
  | "good"
  | "review_recommended"
  | "poor_audio"
  | "suspected_background_media"
  | "insufficient_speech"
  | "transcription_unreliable";

export type IntegrityFlagType =
  | "audio_gap"
  | "background_media"
  | "low_confidence"
  | "rapid_hallucination"
  | "filler_loop"
  | "foreign_hallucination";

export type IntegritySeverity = "info" | "warning" | "critical";

export interface MeetingIntegrityFlag {
  id?: string;
  flagType: IntegrityFlagType;
  severity: IntegritySeverity;
  startMs: number;
  endMs: number;
  reasonCode: string;
  message: string;
  detectorVersion?: string;
}

export interface MeetingIntegrityAnalysis {
  verdict: IntegrityVerdict;
  summary: string;
  usableSpeechPercentage: number;
  confidenceScoreAvg: number;
  backgroundMediaDetected: boolean;
  flags: MeetingIntegrityFlag[];
  metrics: {
    usableSpeechPercentage: number;
    confidenceScoreAvg: number;
    backgroundMediaDetected: boolean;
    totalSpeechMs: number;
    totalDurationSeconds?: number;
    flagCount: number;
  };
}

export interface TranscriptSegmentInput {
  id: string;
  startMs: number;
  endMs: number;
  speakerLabel?: string;
  text: string;
  confidence?: number | null;
}

export interface AnalyzeMeetingIntegrityInput {
  durationSeconds?: number | null;
  segments: TranscriptSegmentInput[];
}

const MEDIA_TOKENS_REGEX =
  /(?:\[(?:music|applause|laughter|silence|audio)\]|\((?:music|applause|laughter|silence|audio)\)|\*(?:music|sings|singing|applause|laughter)\*|[♪♫♩♬])/i;

const REPETITIVE_LOOP_PATTERNS = [
  /thank\s+you(?:\s+very\s+much)?(?:\s+for\s+watching)?/i,
  /subtitles\s+by/i,
  /please\s+(?:subscribe|like)/i,
  /transcription\s+by/i,
  /amara\.org/i,
  /watching!/i,
];

const FOREIGN_HALLUCINATION_PATTERNS = [
  /subtítulos\s+por/i,
  /sous-titres\s+par/i,
  /untertitel\s+von/i,
];

/**
 * Plan A Meeting Integrity V1:
 * Detects automated evidence issues (Whisper hallucination loops, background music/media,
 * extreme audio gaps, low confidence) without unproven diarization/talk-time ratio.
 */
export function analyzeMeetingIntegrity(
  input: AnalyzeMeetingIntegrityInput,
): MeetingIntegrityAnalysis {
  const { segments, durationSeconds } = input;

  if (segments.length === 0) {
    return {
      verdict: "insufficient_speech",
      summary: "No speech segments detected in this recording.",
      usableSpeechPercentage: 0,
      confidenceScoreAvg: 0,
      backgroundMediaDetected: false,
      flags: [],
      metrics: {
        usableSpeechPercentage: 0,
        confidenceScoreAvg: 0,
        backgroundMediaDetected: false,
        totalSpeechMs: 0,
        flagCount: 0,
      },
    };
  }

  const flags: MeetingIntegrityFlag[] = [];
  let totalSpeechMs = 0;
  let totalConfidence = 0;
  let confidenceCount = 0;
  let mediaTokenHits = 0;
  let flaggedSpeechMs = 0;

  // Track repetition across consecutive segments
  let lastNormalizedText = "";
  let repeatCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const duration = Math.max(0, seg.endMs - seg.startMs);
    totalSpeechMs += duration;

    // Check for large audio gaps between consecutive segments (> 20s)
    if (i > 0) {
      const prev = segments[i - 1]!;
      const gapMs = seg.startMs - prev.endMs;
      if (gapMs > 20000) {
        flags.push({
          flagType: "audio_gap",
          severity: gapMs > 60000 ? "warning" : "info",
          startMs: prev.endMs,
          endMs: seg.startMs,
          reasonCode: "gap_exceeded_threshold",
          message: `Extended audio silence/gap of ${Math.round(gapMs / 1000)}s between speech segments.`,
          detectorVersion: "v1",
        });
      }
    }

    // Confidence tracking
    const conf = typeof seg.confidence === "number" ? seg.confidence : 0.85;
    totalConfidence += conf;
    confidenceCount++;

    if (conf < 0.5) {
      flags.push({
        flagType: "low_confidence",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "whisper_low_confidence",
        message: `Low model confidence (${Math.round(conf * 100)}%) on segment.`,
        detectorVersion: "v1",
      });
      flaggedSpeechMs += duration;
    }

    // Check for background media tokens
    if (MEDIA_TOKENS_REGEX.test(seg.text)) {
      mediaTokenHits++;
      flags.push({
        flagType: "background_media",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "media_token_detected",
        message: `Background music, audio or non-speech token detected: "${seg.text.slice(0, 40)}"`,
        detectorVersion: "v1",
      });
      flaggedSpeechMs += duration;
    }

    // Check for known Whisper repetitive loop hallucination tokens
    const isRepetitivePattern = REPETITIVE_LOOP_PATTERNS.some((p) =>
      p.test(seg.text),
    );
    if (isRepetitivePattern) {
      flags.push({
        flagType: "filler_loop",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "hallucination_pattern_hit",
        message: `Whisper filler/hallucination artifact detected: "${seg.text.trim()}"`,
        detectorVersion: "v1",
      });
      flaggedSpeechMs += duration;
    }

    // Check for foreign hallucination markers
    const isForeignHallucination = FOREIGN_HALLUCINATION_PATTERNS.some((p) =>
      p.test(seg.text),
    );
    if (isForeignHallucination) {
      flags.push({
        flagType: "foreign_hallucination",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "foreign_language_loop",
        message: `Foreign subtitle hallucination detected: "${seg.text.trim()}"`,
        detectorVersion: "v1",
      });
      flaggedSpeechMs += duration;
    }

    // Check for consecutive identical text repetitions
    const normalized = seg.text.trim().toLowerCase();
    if (normalized.length > 3 && normalized === lastNormalizedText) {
      repeatCount++;
      if (repeatCount >= 2) {
        flags.push({
          flagType: "rapid_hallucination",
          severity: repeatCount >= 4 ? "critical" : "warning",
          startMs: seg.startMs,
          endMs: seg.endMs,
          reasonCode: "consecutive_repeat_loop",
          message: `Identical phrase repeated ${repeatCount + 1} times consecutively: "${seg.text.trim()}"`,
          detectorVersion: "v1",
        });
        flaggedSpeechMs += duration;
      }
    } else {
      lastNormalizedText = normalized;
      repeatCount = 0;
    }
  }

  const confidenceScoreAvg =
    confidenceCount > 0 ? Number((totalConfidence / confidenceCount).toFixed(2)) : 0;
  const backgroundMediaDetected = mediaTokenHits > 0;

  const usableSpeechMs = Math.max(0, totalSpeechMs - flaggedSpeechMs);
  const usableSpeechPercentage =
    totalSpeechMs > 0
      ? Number(Math.min(100, Math.max(0, (usableSpeechMs / totalSpeechMs) * 100)).toFixed(1))
      : 0;

  // Determine overall verdict
  let verdict: IntegrityVerdict = "good";
  let summary = "Audio evidence is clear and transcription is reliable.";

  if (totalSpeechMs < 10000) {
    verdict = "insufficient_speech";
    summary = "Recording contains very little speech (< 10 seconds total).";
  } else if (flags.some((f) => f.severity === "critical")) {
    verdict = "transcription_unreliable";
    summary = "Critical transcription anomalies or rapid hallucination loops detected. Human review strongly recommended.";
  } else if (mediaTokenHits >= 2) {
    verdict = "suspected_background_media";
    summary = "Multiple background media or music artifacts detected in audio stream.";
  } else if (confidenceScoreAvg < 0.65 || usableSpeechPercentage < 65) {
    verdict = "poor_audio";
    summary = "Low audio clarity or multiple compromised speech segments.";
  } else if (flags.length > 0) {
    verdict = "review_recommended";
    summary = `Review recommended: ${flags.length} integrity warning${flags.length === 1 ? "" : "s"} flagged in evidence.`;
  }

  return {
    verdict,
    summary,
    usableSpeechPercentage,
    confidenceScoreAvg,
    backgroundMediaDetected,
    flags,
    metrics: {
      usableSpeechPercentage,
      confidenceScoreAvg,
      backgroundMediaDetected,
      totalSpeechMs,
      totalDurationSeconds: durationSeconds ?? Math.round(totalSpeechMs / 1000),
      flagCount: flags.length,
    },
  };
}

export interface SaveIntegrityReportInput {
  meetingId: string;
  organizationId: string;
  analysis: MeetingIntegrityAnalysis;
}

/**
 * Persists an evaluated integrity report and its timestamped flags into Postgres.
 */
export async function saveMeetingIntegrityReport(
  supabase: AppSupabaseClient,
  input: SaveIntegrityReportInput,
): Promise<{ reportId: string }> {
  const { meetingId, organizationId, analysis } = input;

  const { data: report, error: reportError } = await supabase
    .from("meeting_integrity_reports")
    .upsert(
      {
        organization_id: organizationId,
        meeting_id: meetingId,
        overall_verdict: analysis.verdict,
        summary: analysis.summary,
        metrics: analysis.metrics as unknown as Json,
        evaluated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id, meeting_id" },
    )
    .select("id")
    .single();

  if (reportError) throw reportError;

  // Clear prior flags for this report before writing fresh flags
  await supabase
    .from("meeting_integrity_flags")
    .delete()
    .eq("report_id", report.id);

  if (analysis.flags.length > 0) {
    const flagInserts = analysis.flags.map((f) => ({
      organization_id: organizationId,
      report_id: report.id,
      flag_type: f.flagType,
      severity: f.severity,
      start_ms: f.startMs,
      end_ms: f.endMs,
      reason_code: f.reasonCode,
      message: f.message,
      detector_version: f.detectorVersion ?? "v1",
    }));

    const { error: flagsError } = await supabase
      .from("meeting_integrity_flags")
      .insert(flagInserts);

    if (flagsError) throw flagsError;
  }

  return { reportId: report.id };
}
