import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

export type IntegrityVerdict =
  | "good"
  | "needs_review"
  | "poor_audio"
  | "suspected_background_media"
  | "insufficient_speech"
  | "transcription_unreliable";

export type IntegrityFlagType =
  | "possible_background_media_or_stt_artifact"
  | "transcript_speech_gap"
  | "low_confidence"
  | "rapid_hallucination"
  | "filler_loop"
  | "foreign_hallucination";

export type IntegritySeverity = "info" | "warning" | "critical";

export interface MeetingIntegrityFlag {
  id?: string;
  meetingId?: string;
  transcriptSegmentId?: string | null;
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
  confidenceScoreAvg: number | null;
  suspectedBackgroundMedia: boolean;
  flags: MeetingIntegrityFlag[];
  metrics: {
    confidenceScoreAvg: number | null;
    suspectedBackgroundMedia: boolean;
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
  meetingId?: string;
}

/**
 * Determines if a transcript with the given integrity verdict is eligible
 * for AI intelligence processing and customer truth materialization.
 *
 * FAIL verdicts block all downstream AI processing:
 * - "transcription_unreliable": critical hallucination loops detected
 * - "insufficient_speech": < 10s of transcribed speech
 *
 * WARN verdicts allow processing but remain auditable:
 * - "needs_review": repetition warnings, multiple flags
 * - "suspected_background_media": media tokens detected
 * - "poor_audio": low quality indicators
 *
 * PASS verdict allows normal processing:
 * - "good": clean transcript
 */
export function isEligibleForIntelligence(verdict: IntegrityVerdict): boolean {
  // FAIL verdicts: block all downstream processing
  if (verdict === "transcription_unreliable" || verdict === "insufficient_speech") {
    return false;
  }
  // WARN and PASS verdicts: allow processing (WARN remains auditable via the report)
  return true;
}

const MEDIA_TOKENS_REGEX =
  /(?:\[(?:music|applause|laughter|silence|audio)\]|\((?:music|applause|laughter|silence|audio)\)|\*(?:music|sings|singing|applause|laughter)\*|[♪♫♩♬])/i;

const REPETITIVE_LOOP_PATTERNS = [
  /thank\s+you(?:\s+very\s+much)?(?:\s+for\s+watching)?/i,
  /subtitles\s+by/i,
  /please\s+(?:subscribe|like)/i,
  /(?:hit|ring)\s+the\s+bell\s+icon/i,
  /(?:like|share)\s+and\s+subscribe/i,
  /transcription\s+by/i,
  /amara\.org/i,
  /watching!/i,
  /copyright\s+disclaimer/i,
  /all\s+rights\s+reserved/i,
  /patreon\.com/i,
];

const FOREIGN_HALLUCINATION_PATTERNS = [
  /subtítulos\s+por/i,
  /sous-titres\s+par/i,
  /untertitel\s+von/i,
];

/**
 * Detects in-segment repetition loops (e.g. "thank you thank you thank you" or "yeah yeah yeah yeah").
 */
export function detectInSegmentLoops(text: string): { phrase: string; count: number } | null {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ");
  if (words.length < 4) return null;

  // 1. Single-word consecutive repetition (e.g. "yeah yeah yeah yeah")
  let currentWordCount = 1;
  let maxWordCount = 1;
  let maxWord = "";
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1] && words[i]!.length > 1) {
      currentWordCount++;
      if (currentWordCount > maxWordCount) {
        maxWordCount = currentWordCount;
        maxWord = words[i]!;
      }
    } else {
      currentWordCount = 1;
    }
  }
  if (maxWordCount >= 4) {
    return { phrase: maxWord, count: maxWordCount };
  }

  // 2. Multi-word phrase repetition (2-4 words repeated 3+ times consecutively)
  for (let phraseLen = 2; phraseLen <= 4; phraseLen++) {
    for (let i = 0; i <= words.length - phraseLen * 3; i++) {
      const phrase = words.slice(i, i + phraseLen).join(" ");
      let count = 1;
      let j = i + phraseLen;
      while (j <= words.length - phraseLen) {
        const nextPhrase = words.slice(j, j + phraseLen).join(" ");
        if (nextPhrase === phrase) {
          count++;
          j += phraseLen;
        } else {
          break;
        }
      }
      if (count >= 3) {
        return { phrase, count };
      }
    }
  }

  return null;
}

/**
 * Plan A Meeting Integrity V1:
 * Analyzes TRANSCRIPT patterns (Whisper hallucination loops, background music/media tokens,
 * transcript speech gaps, model confidence).
 * Semantics strictly describe transcript heuristics, not raw audio or VAD facts.
 */
export function analyzeMeetingIntegrity(
  input: AnalyzeMeetingIntegrityInput,
): MeetingIntegrityAnalysis {
  const { segments, meetingId } = input;

  if (segments.length === 0) {
    return {
      verdict: "insufficient_speech",
      summary: "No transcribed speech segments found.",
      confidenceScoreAvg: null,
      suspectedBackgroundMedia: false,
      flags: [],
      metrics: {
        confidenceScoreAvg: null,
        suspectedBackgroundMedia: false,
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

  // Track repetition across consecutive segments
  let lastNormalizedText = "";
  let repeatCount = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const duration = Math.max(0, seg.endMs - seg.startMs);
    totalSpeechMs += duration;

    // Check for large gaps between consecutive transcript segments (> 20s)
    if (i > 0) {
      const prev = segments[i - 1]!;
      const gapMs = seg.startMs - prev.endMs;
      if (gapMs > 20000) {
        flags.push({
          meetingId,
          transcriptSegmentId: prev.id,
          flagType: "transcript_speech_gap",
          severity: gapMs > 60000 ? "warning" : "info",
          startMs: prev.endMs,
          endMs: seg.startMs,
          reasonCode: "gap_exceeded_threshold",
          message: `No transcribed speech in this interval (${Math.round(gapMs / 1000)}s gap).`,
          detectorVersion: "v1",
        });
      }
    }

    // Confidence tracking: only average values that actually exist
    if (typeof seg.confidence === "number" && !Number.isNaN(seg.confidence)) {
      totalConfidence += seg.confidence;
      confidenceCount++;

      if (seg.confidence < 0.5) {
        flags.push({
          meetingId,
          transcriptSegmentId: seg.id,
          flagType: "low_confidence",
          severity: "warning",
          startMs: seg.startMs,
          endMs: seg.endMs,
          reasonCode: "whisper_low_confidence",
          message: `Low model confidence (${Math.round(seg.confidence * 100)}%) on segment.`,
          detectorVersion: "v1",
        });
      }
    }

    // Check for background media / STT artifact tokens
    if (MEDIA_TOKENS_REGEX.test(seg.text)) {
      mediaTokenHits++;
      flags.push({
        meetingId,
        transcriptSegmentId: seg.id,
        flagType: "possible_background_media_or_stt_artifact",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "media_token_detected",
        message: `Possible background media or STT artifact: "${seg.text.slice(0, 40)}"`,
        detectorVersion: "v1",
      });
    }

    // Check for known Whisper repetitive loop hallucination tokens
    const isRepetitivePattern = REPETITIVE_LOOP_PATTERNS.some((p) =>
      p.test(seg.text),
    );
    if (isRepetitivePattern) {
      flags.push({
        meetingId,
        transcriptSegmentId: seg.id,
        flagType: "filler_loop",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "hallucination_pattern_hit",
        message: `Whisper filler/hallucination artifact detected: "${seg.text.trim()}"`,
        detectorVersion: "v1",
      });
    }

    // Check for foreign hallucination markers
    const isForeignHallucination = FOREIGN_HALLUCINATION_PATTERNS.some((p) =>
      p.test(seg.text),
    );
    if (isForeignHallucination) {
      flags.push({
        meetingId,
        transcriptSegmentId: seg.id,
        flagType: "foreign_hallucination",
        severity: "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "foreign_language_loop",
        message: `Foreign subtitle hallucination detected: "${seg.text.trim()}"`,
        detectorVersion: "v1",
      });
    }

    // Check for in-segment repetition loops (e.g. single segment with looping tokens)
    const inSegLoop = detectInSegmentLoops(seg.text);
    if (inSegLoop) {
      flags.push({
        meetingId,
        transcriptSegmentId: seg.id,
        flagType: "rapid_hallucination",
        severity: inSegLoop.count >= 5 ? "critical" : "warning",
        startMs: seg.startMs,
        endMs: seg.endMs,
        reasonCode: "in_segment_repetition_loop",
        message: `Phrase/token "${inSegLoop.phrase}" repeated ${inSegLoop.count} times within single segment.`,
        detectorVersion: "v1",
      });
    }

    // Check for consecutive identical text repetitions
    const normalized = seg.text.trim().toLowerCase();
    if (normalized.length > 3 && normalized === lastNormalizedText) {
      repeatCount++;
      if (repeatCount >= 2) {
        flags.push({
          meetingId,
          transcriptSegmentId: seg.id,
          flagType: "rapid_hallucination",
          severity: repeatCount >= 4 ? "critical" : "warning",
          startMs: seg.startMs,
          endMs: seg.endMs,
          reasonCode: "consecutive_repeat_loop",
          message: `Identical phrase repeated ${repeatCount + 1} times consecutively: "${seg.text.trim()}"`,
          detectorVersion: "v1",
        });
      }
    } else {
      lastNormalizedText = normalized;
      repeatCount = 0;
    }
  }

  const confidenceScoreAvg =
    confidenceCount > 0
      ? Number((totalConfidence / confidenceCount).toFixed(2))
      : null;
  const suspectedBackgroundMedia = mediaTokenHits > 0;

  // Determine overall verdict
  let verdict: IntegrityVerdict = "good";
  let summary = "Good transcript quality with clear transcription.";

  if (totalSpeechMs < 10000) {
    verdict = "insufficient_speech";
    summary = "Recording contains very little transcribed speech (< 10 seconds total).";
  } else if (flags.some((f) => f.severity === "critical")) {
    verdict = "transcription_unreliable";
    summary = "Severe transcript repetition loops detected; human review strongly recommended.";
  } else if (suspectedBackgroundMedia) {
    verdict = "suspected_background_media";
    summary = "Possible background media or non-speech artifacts detected in transcript.";
  } else if (flags.some((f) => f.flagType === "rapid_hallucination" || f.flagType === "filler_loop")) {
    verdict = "needs_review";
    summary = "Transcript repetition warnings detected; AM review recommended.";
  } else if (flags.length > 3) {
    verdict = "needs_review";
    summary = "Multiple transcript speech warnings detected; review recommended.";
  }

  return {
    verdict,
    summary,
    confidenceScoreAvg,
    suspectedBackgroundMedia,
    flags,
    metrics: {
      confidenceScoreAvg,
      suspectedBackgroundMedia,
      totalSpeechMs,
      totalDurationSeconds: input.durationSeconds ?? undefined,
      flagCount: flags.length,
    },
  };
}

export interface SaveMeetingIntegrityReportInput {
  organizationId: string;
  meetingId: string;
  analysis: MeetingIntegrityAnalysis;
}

/**
 * Persists an integrity analysis atomically using the atomic RPC save_meeting_integrity_report_atomic.
 * Replaces the report row and all flags in a single transaction.
 * Strictly service_role execution.
 */
export async function saveMeetingIntegrityReport(
  serviceRoleClient: AppSupabaseClient,
  input: SaveMeetingIntegrityReportInput,
): Promise<{ reportId: string }> {
  const flagsPayload = input.analysis.flags.map((f) => ({
    transcript_segment_id: f.transcriptSegmentId ?? null,
    flag_type: f.flagType,
    severity: f.severity,
    start_ms: f.startMs,
    end_ms: f.endMs,
    reason_code: f.reasonCode,
    message: f.message,
    detector_version: f.detectorVersion ?? "v1",
  }));

  const { data, error } = await serviceRoleClient.rpc(
    "save_meeting_integrity_report_atomic",
    {
      p_organization_id: input.organizationId,
      p_meeting_id: input.meetingId,
      p_overall_verdict: input.analysis.verdict,
      p_summary: input.analysis.summary,
      p_confidence_score_avg: input.analysis.confidenceScoreAvg ?? (null as unknown as number),
      p_suspected_background_media: input.analysis.suspectedBackgroundMedia,
      p_metrics: input.analysis.metrics as unknown as Json,
      p_flags: flagsPayload as unknown as Json,
    },
  );

  if (error) throw error;
  if (!data?.id) throw new Error("Atomic integrity report save did not return report id.");

  return { reportId: data.id };
}

/**
 * Automatically evaluates transcript integrity for a completed meeting transcript
 * and persists the report and flags atomically.
 * Idempotent, retry-safe, service-role only.
 */
export async function evaluateAndPersistMeetingIntegrity(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
): Promise<MeetingIntegrityAnalysis> {
  const { data: transcript, error: trError } = await serviceRoleClient
    .from("meeting_transcripts")
    .select("id")
    .eq("meeting_id", meetingId)
    .eq("organization_id", organizationId)
    .single();
  if (trError) throw trError;

  const { data: segments, error: segError } = await serviceRoleClient
    .from("transcript_segments")
    .select("id, start_ms, end_ms, original_text, canonical_english_text, speaker_label, transcription_confidence")
    .eq("transcript_id", transcript.id)
    .order("sequence_index", { ascending: true });
  if (segError) throw segError;

  const analysis = analyzeMeetingIntegrity({
    meetingId,
    segments: (segments ?? []).map((s) => ({
      id: s.id,
      startMs: s.start_ms,
      endMs: s.end_ms,
      text: s.canonical_english_text ?? s.original_text,
      speakerLabel: s.speaker_label ?? undefined,
      confidence:
        s.transcription_confidence != null
          ? Number(s.transcription_confidence)
          : undefined,
    })),
  });

  await saveMeetingIntegrityReport(serviceRoleClient, {
    organizationId,
    meetingId,
    analysis,
  });

  return analysis;
}
