import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeProviderBotId,
  type VexaEnv,
} from "@applywizz/meeting-bots";
import type {
  EnglishNormalizationProvider,
  TranscriptionProvider,
} from "@applywizz/transcription";
import {
  TranscodeError,
  assertTranscodableInputSize,
  computeBytesSha256,
  computeFileSha256,
  probeAudioFile,
  transcodeToOpusOgg,
  transcodeToPcmWav,
} from "./audio-transcode";
import { logLifecycleEvent } from "./meeting-bots";
import {
  ensureOwnedRecording,
  RecordingNotReadyError,
  type RecordingStorageClient,
} from "./meeting-recordings";
import { evaluateAndPersistMeetingIntegrity } from "./meeting-integrity";

export type AppSupabaseClient = SupabaseClient<Database>;

type TranscriptRow = Database["public"]["Tables"]["meeting_transcripts"]["Row"];

const MAX_RETRY_COUNT = 5;
const RETRY_BACKOFF_BASE_MS = 30_000;

function retryBackoff(retryCount: number): string {
  const delayMs = Math.min(
    RETRY_BACKOFF_BASE_MS * 2 ** retryCount,
    30 * 60 * 1000,
  );
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * Scans every 'completed' bot job whose meeting has no transcript row yet
 * and enqueues one. Idempotent: meeting_transcripts_org_meeting_uq
 * (unique(organization_id, meeting_id)) is the actual enforcement — a
 * 23505 here just means another concurrent scan already enqueued it.
 */
export async function enqueuePendingTranscriptions(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<{ enqueued: number }> {
  const { data: completedJobs, error: jobsError } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select("meeting_id")
    .eq("organization_id", organizationId)
    .eq("status", "completed");
  if (jobsError) throw jobsError;

  const { data: existing, error: existingError } = await serviceRoleClient
    .from("meeting_transcripts")
    .select("meeting_id")
    .eq("organization_id", organizationId);
  if (existingError) throw existingError;
  const alreadyTracked = new Set((existing ?? []).map((t) => t.meeting_id));

  const meetingIds = Array.from(
    new Set(
      (completedJobs ?? [])
        .map((j) => j.meeting_id)
        .filter((id) => !alreadyTracked.has(id)),
    ),
  );

  let enqueued = 0;
  for (const meetingId of meetingIds) {
    const { error: insertError } = await serviceRoleClient
      .from("meeting_transcripts")
      .insert({
        organization_id: organizationId,
        meeting_id: meetingId,
        processing_status: "pending",
      });
    if (insertError) {
      if (insertError.code === "23505") continue; // raced with another scan — fine
      throw insertError;
    }
    enqueued += 1;
    await logLifecycleEvent(serviceRoleClient, {
      meetingId,
      organizationId,
      eventType: "transcript.enqueued",
      source: "worker",
    });
  }

  return { enqueued };
}

export interface TranscriptionDeps {
  vexaEnv: VexaEnv;
  transcriptionProvider: TranscriptionProvider;
  normalizationProvider: EnglishNormalizationProvider;
  storage: RecordingStorageClient;
  fetchImpl?: typeof fetch;
}

/** Machine-readable failure classification — never the raw provider error body (may embed transcript content). */
type FailureCode =
  | "recording_not_ready"
  | "download_failed"
  | "transcode_failed"
  | "transcode_timeout"
  | "stt_failed"
  | "stt_timeout"
  | "stt_malformed_response"
  | "normalization_failed"
  | "unknown";

function classifyError(error: unknown): { code: FailureCode; message: string } {
  if (error instanceof RecordingNotReadyError) {
    return { code: "recording_not_ready", message: error.message };
  }
  if (error instanceof TranscodeError) {
    return {
      code:
        error.name === "TranscodeTimeoutError"
          ? "transcode_timeout"
          : "transcode_failed",
      message: error.message,
    };
  }
  if (error instanceof Error) {
    if (error.name === "TranscriptionTimeoutError")
      return { code: "stt_timeout", message: error.message };
    if (error.name === "TranscriptionMalformedResponseError") {
      return { code: "stt_malformed_response", message: error.message };
    }
    if (error.name === "TranscriptionApiError")
      return { code: "stt_failed", message: error.message };
    if (
      error.name === "VexaApiError" ||
      error.name === "VexaAuthError" ||
      error.name === "VexaRateLimitError"
    ) {
      return { code: "download_failed", message: error.message };
    }
    return { code: "unknown", message: error.message };
  }
  return { code: "unknown", message: String(error) };
}

// Single source of truth lives in meeting-recordings.ts (Task 4) — that
// module's own RecordingNotReadyError was deliberately kept byte-identical
// to this one, so re-exporting it here (rather than keeping a second class
// with the same name/message) is a no-op for every existing
// `instanceof RecordingNotReadyError` check below (classifyError) and for
// every external caller of this module that imports the error from here.
export { RecordingNotReadyError };

/**
 * The full real pipeline, proven for real during the M8 readiness
 * investigation: fetch Vexa's recording reference -> download raw bytes ->
 * remux/transcode (Vexa's export is not directly STT-compatible) ->
 * validate -> transcribe -> normalize non-English segments -> persist.
 * Every temp file is deleted in `finally`, regardless of outcome. A retry
 * always deletes any segments the previous attempt already wrote before
 * re-inserting (transcript isn't 'completed' yet, so this is safe — the
 * evidence-immutability trigger only locks a COMPLETED transcript's
 * segments) — that's what makes a retry idempotent rather than hitting the
 * (transcript_id, sequence_index) unique constraint.
 */
export async function processTranscriptionJob(
  serviceRoleClient: AppSupabaseClient,
  transcript: TranscriptRow,
  deps: TranscriptionDeps,
): Promise<void> {
  let workDir: string | null = null;
  try {
    const { data: botJob, error: botJobError } = await serviceRoleClient
      .from("meeting_bot_jobs")
      .select("provider_bot_id, provider_metadata")
      .eq("meeting_id", transcript.meeting_id)
      .eq("organization_id", transcript.organization_id)
      .eq("status", "completed")
      .not("provider_bot_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (botJobError) throw botJobError;
    if (!botJob?.provider_bot_id) throw new RecordingNotReadyError();

    const identity = decodeProviderBotId(botJob.provider_bot_id);

    // M17C: GET /recordings only honors a numeric `meeting_id` filter
    // (Vexa's own id from the POST /bots response, stored verbatim in
    // provider_metadata) — the platform/native_meeting_id pair above is
    // NOT an honored filter on this endpoint (confirmed against the real
    // hosted API: a bogus native_meeting_id still returned every
    // recording). A job whose provider_metadata predates this or is
    // malformed has nothing usable to look up yet.
    const rawVexaMeetingId = (botJob.provider_metadata as { id?: unknown } | null)
      ?.id;
    const vexaMeetingId =
      typeof rawVexaMeetingId === "number"
        ? rawVexaMeetingId
        : typeof rawVexaMeetingId === "string" && rawVexaMeetingId.trim() !== ""
          ? Number(rawVexaMeetingId)
          : NaN;
    if (!Number.isFinite(vexaMeetingId)) throw new RecordingNotReadyError();

    // Ownership handoff (P2): if this meeting's recording is already owned
    // (a meeting_recordings row exists), ensureOwnedRecording downloads it
    // straight from our own Storage bucket and never contacts Vexa at all.
    // Only a first-time/never-ingested meeting reaches out to Vexa here —
    // once owned, Vexa is no longer needed for transcription.
    const { recordingRef: ownedRecordingRef, bytes: rawBytes } =
      await ensureOwnedRecording(serviceRoleClient, deps.storage, {
        organizationId: transcript.organization_id,
        meetingId: transcript.meeting_id,
        vexaMeetingId,
        vexaEnv: deps.vexaEnv,
        fetchImpl: deps.fetchImpl,
      });
    assertTranscodableInputSize(rawBytes.byteLength);

    workDir = await mkdtemp(join(tmpdir(), "signal-transcode-"));
    // Codex post-implementation review (SHOULD-FIX): recordingRef.format
    // comes straight from Vexa's own API response — a fixed filename
    // means nothing from that external value ever reaches a filesystem
    // path. ffmpeg probes actual input format from file content, not
    // filename extension, so this doesn't need a "correct" extension —
    // verified for real against the actual Vexa recording during the
    // readiness investigation.
    const rawPath = join(workDir, "raw.input");
    const isAzure = deps.transcriptionProvider.name === "azure-mai";
    const cleanPath = join(workDir, isAzure ? "derived.wav" : "clean.ogg");
    await writeFile(rawPath, new Uint8Array(rawBytes));

    if (isAzure) {
      await transcodeToPcmWav(rawPath, cleanPath);
    } else {
      await transcodeToOpusOgg(rawPath, cleanPath);
    }

    const probe = await probeAudioFile(cleanPath);
    if (
      !probe.hasAudioStream ||
      !probe.durationSeconds ||
      probe.durationSeconds <= 0
    ) {
      throw new (class extends TranscodeError {
        constructor() {
          super("Transcoded output has no usable audio stream.");
          this.name = "TranscodeFailedError";
        }
      })();
    }

    const originalSha256 = computeBytesSha256(new Uint8Array(rawBytes));
    const derivedSha256 = await computeFileSha256(cleanPath);
    const preprocessingVersion = isAzure ? "v1-pcm16k-wav" : "v1-opus16k-ogg";

    const result = await deps.transcriptionProvider.transcribe(cleanPath);
    const detectedLanguage = result.detectedLanguage;

    const segmentRows: Record<string, unknown>[] = [];
    for (const segment of result.segments) {
      const segmentLanguage = segment.language ?? result.detectedLanguage ?? null;
      const isEnglish = segmentLanguage === "en";
      let canonicalEnglishText: string | null = null;
      let translationConfidence: number | null = null;
      const needsReview = !isEnglish;

      if (isEnglish) {
        canonicalEnglishText = segment.text;
      } else if (segment.text.trim().length > 0) {
        try {
          const normalized = await deps.normalizationProvider.normalize(
            segment.text,
            segmentLanguage,
          );
          canonicalEnglishText = normalized.canonicalEnglishText;
          translationConfidence = normalized.confidence;
        } catch {
          // Graceful per-segment degradation — one bad normalization call
          // must not fail the whole meeting's transcript. Original text is
          // still fully preserved; needs_review stays true.
          canonicalEnglishText = null;
        }
      }

      const speakerNumericId =
        typeof segment.speakerNumericId === "number" &&
        Number.isFinite(segment.speakerNumericId)
          ? segment.speakerNumericId
          : null;

      const providerSegmentMetadata: Record<string, unknown> = {
        speakerTag: segment.speakerTag ?? "speaker_unknown",
        speakerNumericId,
        speakerSource:
          segment.speakerTag && segment.speakerTag !== "speaker_unknown"
            ? (isAzure ? "azure-diarization" : "provider-diarization")
            : "unavailable",
        language: segmentLanguage,
        words: segment.words && segment.words.length > 0 ? segment.words : null,
      };

      segmentRows.push({
        sequence_index: segment.index,
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        original_text: segment.text,
        original_language: segmentLanguage,
        canonical_english_text: canonicalEnglishText,
        speaker_label: segment.speakerTag ?? "speaker_unknown",
        speaker_source: "unavailable",
        transcription_confidence: segment.confidence,
        translation_confidence: translationConfidence,
        needs_review: needsReview,
        provider_segment_metadata: providerSegmentMetadata,
      });
    }

    // Explicitly record provider name on meeting_transcripts row
    await serviceRoleClient
      .from("meeting_transcripts")
      .update({
        provider: deps.transcriptionProvider.name,
      })
      .eq("id", transcript.id)
      .eq("organization_id", transcript.organization_id);

    // Codex post-implementation review (2 BLOCKING findings, fixed): this
    // used to be three separate delete/insert/update PostgREST calls —
    // not atomic (a crash between them left the transcript stuck
    // 'processing' with segments already gone), and service_role was
    // never actually granted DELETE on transcript_segments in the first
    // place (invisible to pgTAP, which tests as the table owner, not the
    // real service_role grant set). complete_transcription_job (migration
    // 060003) does the delete-then-reinsert-then-complete as ONE
    // Postgres transaction, as a SECURITY DEFINER function — it needs no
    // direct DELETE grant at all, and it refuses to touch an
    // already-'completed' transcript's evidence before ever issuing the
    // delete (a second, independent layer on top of the BEFORE DELETE
    // trigger the same migration adds).
    // The generated RPC arg types are non-nullable (Supabase's type
    // generator doesn't reflect real SQL parameter nullability) even
    // though detected_language/usage_seconds/usage_cost are all genuinely
    // nullable in Postgres and at runtime — this cast only relaxes that
    // codegen gap, it does not change what's actually sent.
    const { data: completed, error: completeError } =
      await serviceRoleClient.rpc("complete_transcription_job", {
        p_transcript_id: transcript.id,
        p_organization_id: transcript.organization_id,
        p_model: result.model,
        p_detected_language: detectedLanguage,
        p_has_canonical_english: segmentRows.some(
          (s) => s.canonical_english_text !== null,
        ),
        p_source_audio_reference: {
          recordingId: ownedRecordingRef.id,
          storageBucket: ownedRecordingRef.storageBucket,
          storagePath: ownedRecordingRef.storagePath,
          platform: identity.platform,
          nativeMeetingId: identity.nativeMeetingId,
          originalSha256,
          derivedSha256,
          preprocessingVersion,
        } as Json,
        p_provider_metadata: {
          ...result.providerMetadata,
          provider: deps.transcriptionProvider.name,
          originalSha256,
          derivedSha256,
          preprocessingVersion,
        } as Json,
        p_usage_seconds: result.usage.seconds,
        p_usage_cost: result.usage.cost,
        p_segments: segmentRows as unknown as Json,
      } as Database["public"]["Functions"]["complete_transcription_job"]["Args"]);
    if (completeError) throw completeError;
    if (!completed) {
      // Already completed by a concurrent run — not an error, just a lost
      // race; nothing further to do for this attempt.
      return;
    }

    await logLifecycleEvent(serviceRoleClient, {
      meetingId: transcript.meeting_id,
      organizationId: transcript.organization_id,
      eventType: "transcript.completed",
      source: "worker",
      payload: { segmentCount: segmentRows.length, detectedLanguage },
    });

    // Best-effort automatic transcript integrity analysis upon transcript completion (Blocker 6)
    // Raw evidence is already durable; evaluation failures must never revert completed transcript.
    try {
      await evaluateAndPersistMeetingIntegrity(
        serviceRoleClient,
        transcript.meeting_id,
        transcript.organization_id,
      );
    } catch {
      // Best-effort hook; reconciliation sweep will pick it up if missed.
    }
  } catch (error) {
    const { code, message } = classifyError(error);
    const nextRetryCount = transcript.retry_count + 1;
    const terminal = nextRetryCount >= MAX_RETRY_COUNT;

    const { error: updateError } = await serviceRoleClient
      .from("meeting_transcripts")
      .update({
        processing_status: terminal ? "failed" : "retryable",
        error_code: code,
        // message only — never the raw error object, which for a provider
        // error could echo request content.
        safe_error_metadata: { message } as Json,
        retry_count: nextRetryCount,
        next_retry_at: terminal ? null : retryBackoff(nextRetryCount),
      })
      .eq("id", transcript.id)
      .eq("organization_id", transcript.organization_id);
    if (updateError) throw updateError;

    await logLifecycleEvent(serviceRoleClient, {
      meetingId: transcript.meeting_id,
      organizationId: transcript.organization_id,
      eventType: `transcript.${terminal ? "failed" : "retry_scheduled"}`,
      source: "worker",
      payload: { errorCode: code },
    });
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

export interface ProcessTranscriptionQueueResult {
  claimed: number;
  completed: number;
  failedOrRetrying: number;
}

/** Drains up to maxJobs pending/retryable transcription jobs, one atomic claim (claim_next_transcription_job, FOR UPDATE SKIP LOCKED) at a time. */
export async function processTranscriptionQueue(
  serviceRoleClient: AppSupabaseClient,
  deps: TranscriptionDeps,
  maxJobs = 5,
): Promise<ProcessTranscriptionQueueResult> {
  const result: ProcessTranscriptionQueueResult = {
    claimed: 0,
    completed: 0,
    failedOrRetrying: 0,
  };

  for (let i = 0; i < maxJobs; i += 1) {
    const { data: job, error: claimError } = await serviceRoleClient.rpc(
      "claim_next_transcription_job",
    );
    if (claimError) throw claimError;
    if (!job?.id) break;

    result.claimed += 1;
    await processTranscriptionJob(serviceRoleClient, job, deps);

    const { data: refreshed, error: refreshError } = await serviceRoleClient
      .from("meeting_transcripts")
      .select("processing_status")
      .eq("id", job.id)
      .eq("organization_id", job.organization_id)
      .single();
    if (refreshError) throw refreshError;
    if (refreshed.processing_status === "completed") result.completed += 1;
    else result.failedOrRetrying += 1;
  }

  return result;
}
