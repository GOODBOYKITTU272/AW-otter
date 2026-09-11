"use client";

import type {
  MeetingIntegrityAnalysis,
  MeetingIntegrityFlag,
  IntegrityVerdict,
} from "@applywizz/domain/meeting-integrity";
import { StatusBadge, type BadgeTone } from "../admin/status-badge";

const VERDICT_LABEL: Record<IntegrityVerdict, string> = {
  good: "High Audio Integrity",
  needs_review: "Review Recommended",
  poor_audio: "Poor Audio Quality",
  suspected_background_media: "Background Media Detected",
  insufficient_speech: "Insufficient Speech",
  transcription_unreliable: "Transcription Unreliable",
};

const VERDICT_TONE: Record<IntegrityVerdict, BadgeTone> = {
  good: "success",
  needs_review: "warning",
  poor_audio: "critical",
  suspected_background_media: "warning",
  insufficient_speech: "neutral",
  transcription_unreliable: "critical",
};

const FLAG_TYPE_LABEL: Record<string, string> = {
  possible_background_media_or_stt_artifact: "Possible Artifact / Media",
  transcript_speech_gap: "Speech Gap",
  audio_gap: "Speech Gap",
  background_media: "Possible Artifact / Media",
  low_confidence: "Low Model Confidence",
  rapid_hallucination: "Hallucination Loop",
  rapid_repetition: "Repetition Loop",
  filler_loop: "Filler Repetition",
  unsupported_foreign_speech: "Foreign Speech Artifact",
  foreign_hallucination: "Foreign Language Artifact",
  suspected_hallucination: "Suspected Hallucination",
};

export function MeetingIntegrityCard({
  integrity,
  onSeek,
}: {
  integrity: MeetingIntegrityAnalysis;
  onSeek?: (ms: number) => void;
}) {
  const flags = integrity.flags ?? [];

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200/80 pb-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Transcript Integrity & Review Warnings
          </span>
          <StatusBadge tone={VERDICT_TONE[integrity.verdict] ?? "neutral"}>
            {VERDICT_LABEL[integrity.verdict] ?? integrity.verdict}
          </StatusBadge>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            Confidence:{" "}
            <span className="font-medium text-zinc-700 dark:text-zinc-300">
              {integrity.confidenceScoreAvg != null
                ? `${Math.round(integrity.confidenceScoreAvg * 100)}%`
                : "Not available"}
            </span>
          </span>
        </div>
      </div>

      <div className="mt-3 text-xs text-zinc-600 dark:text-zinc-400">
        <p>{integrity.summary}</p>
      </div>

      {flags.length > 0 && (
        <div className="mt-4 border-t border-zinc-200/80 pt-3 dark:border-zinc-800">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-400">
            Evidence Flags & Timestamp Warnings ({flags.length})
          </p>
          <div className="mt-2 space-y-1.5">
            {flags.map((f: MeetingIntegrityFlag, idx: number) => (
              <div
                key={`${f.reasonCode}-${f.startMs}-${idx}`}
                className="flex items-center justify-between rounded bg-amber-50/80 px-2.5 py-2 text-xs text-amber-950 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <span className="shrink-0 rounded bg-amber-200/70 px-1 py-0.5 font-mono text-[10px] font-semibold uppercase text-amber-900 dark:bg-amber-900 dark:text-amber-200">
                    {FLAG_TYPE_LABEL[f.flagType] ?? f.flagType}
                  </span>
                  <span className="truncate text-zinc-800 dark:text-zinc-200">
                    {f.message}
                  </span>
                </div>
                {onSeek && (
                  <button
                    type="button"
                    onClick={() => onSeek(f.startMs)}
                    className="shrink-0 font-mono text-[11px] font-medium text-indigo-600 underline hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                    title={`Seek playback to ${formatTimestamp(f.startMs)}`}
                  >
                    Seek {formatTimestamp(f.startMs)}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
