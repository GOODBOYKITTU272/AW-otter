import type { VexaEnv } from "./config";
import { VexaApiError, normalizeVexaError } from "./errors";

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;
/**
 * Codex post-implementation review (SHOULD-FIX): downloads were previously
 * unbounded with no timeout — response.arrayBuffer() would buffer an
 * arbitrarily large body fully in memory before
 * assertTranscodableInputSize (packages/domain) ever got a chance to
 * reject it. Streaming with a running byte count means an oversized
 * response is aborted mid-download, never fully buffered. Mirrors
 * packages/domain/src/audio-transcode.ts's own MAX_TRANSCODE_INPUT_BYTES
 * value — kept as a separate local constant deliberately (this package
 * must not depend on packages/domain, which depends on it).
 */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * M8 readiness investigation (2026-09-08) confirmed against the REAL
 * self-hosted deployment: recording happens by default
 * (`recording_enabled: true`) independently of `transcribe_enabled` (M6
 * set that to false) — real audio already exists for every completed M6
 * bot session, no change to bot creation needed. GET
 * /transcripts/{platform}/{native_meeting_id} was confirmed to embed the
 * meeting's `recordings[]` directly — a single call, no separate
 * bots-list -> internal-numeric-id -> recordings-by-id lookup needed.
 */
interface RawMediaFile {
  id?: number;
  type?: string;
  format?: string;
  is_final?: boolean;
}

interface RawRecording {
  id?: number;
  status?: string;
  media_files?: RawMediaFile[];
}

interface RawTranscriptResponse {
  recordings?: RawRecording[];
}

export interface RecordingRef {
  recordingId: number;
  mediaFileId: number;
  format: string;
}

async function vexaGet<T>(
  env: VexaEnv,
  path: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(
    `${env.baseUrl.replace(/\/+$/, "")}${path}`,
    {
      method: "GET",
      headers: { "X-API-Key": env.apiKey },
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw normalizeVexaError(
      response.status,
      body,
      response.headers.get("retry-after"),
    );
  }
  return body as T;
}

/**
 * Resolves the audio artifact reference for a completed meeting. Picks the
 * most recent COMPLETED recording's audio media file (real data confirmed
 * `type: "audio"` is present alongside a null `type: "video"` for a
 * bot-recorded audio-only session). Returns null — never guesses/fabricates
 * a reference — if no completed audio recording exists yet.
 */
export async function getMeetingRecordingRef(
  env: VexaEnv,
  platform: string,
  nativeMeetingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecordingRef | null> {
  const raw = await vexaGet<RawTranscriptResponse>(
    env,
    `/transcripts/${platform}/${encodeURIComponent(nativeMeetingId)}`,
    fetchImpl,
  );

  const completedRecordings = (raw.recordings ?? []).filter(
    (r) => r.status === "completed",
  );
  // Most recently created recording wins if more than one exists — real
  // data never showed this, but a re-recorded/re-joined session is
  // plausible; picking the latest is the same "most recent wins"
  // convention used elsewhere in this codebase (reresolveCustomerOwner).
  const recording = completedRecordings[completedRecordings.length - 1];
  if (!recording || typeof recording.id !== "number") return null;

  const audioFile = (recording.media_files ?? []).find(
    (f) => f.type === "audio",
  );
  if (!audioFile || typeof audioFile.id !== "number") return null;

  return {
    recordingId: recording.id,
    mediaFileId: audioFile.id,
    format: audioFile.format ?? "webm",
  };
}

/**
 * Downloads the raw recorded bytes. Verified for real: this endpoint and
 * `/raw` return byte-identical content, and BOTH are rejected by
 * OpenRouter's Whisper backend as "unsupported or malformed audio" without
 * a local remux/transcode step first (see
 * packages/domain/src/audio-transcode.ts) — this function only fetches,
 * it never assumes the bytes are directly STT-compatible.
 */
export async function downloadRecordingMedia(
  env: VexaEnv,
  recordingId: number,
  mediaFileId: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_DOWNLOAD_TIMEOUT_MS,
): Promise<ArrayBuffer> {
  // Codex post-implementation review (SHOULD-FIX, second pass): the timer
  // used to be cleared as soon as fetch() resolved (i.e. once response
  // headers arrived), leaving the actual body-read loop below completely
  // unbounded — a stalled/slow body stream after headers would hang
  // forever. The same controller/timer now stays live across the WHOLE
  // function (fetch + full body read), only cleared in the outer
  // `finally` once everything is done. Aborting mid-read rejects the
  // in-flight reader.read() with an AbortError (standard fetch-stream
  // semantics — aborting the controller cancels body consumption too),
  // which is mapped to a typed timeout error below.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${env.baseUrl.replace(/\/+$/, "")}/recordings/${recordingId}/media/${mediaFileId}/download`,
      {
        method: "GET",
        headers: { "X-API-Key": env.apiKey },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw normalizeVexaError(
        response.status,
        body,
        response.headers.get("retry-after"),
      );
    }

    if (!response.body) {
      return await response.arrayBuffer();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new VexaApiError(
          413,
          `Recording download exceeded the ${MAX_DOWNLOAD_BYTES} byte limit.`,
        );
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged.buffer;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new VexaApiError(
        408,
        "Recording download timed out (including a stalled body stream).",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
