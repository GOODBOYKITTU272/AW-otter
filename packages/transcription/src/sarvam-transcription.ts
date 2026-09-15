import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DEFAULT_SARVAM_MODE,
  DEFAULT_SARVAM_MODEL,
  DEFAULT_SARVAM_POLL_INTERVAL_MS,
  DEFAULT_SARVAM_TIMEOUT_MS,
  SARVAM_BASE_URL,
} from "./config";
import {
  TranscriptionApiError,
  TranscriptionAuthError,
  TranscriptionEmptyTranscriptError,
  TranscriptionMalformedResponseError,
  TranscriptionRateLimitError,
  TranscriptionTimeoutError,
} from "./errors";
import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionSegment,
} from "./types";

export interface RawSarvamDiarizedEntry {
  transcript?: string;
  start_time_seconds?: number;
  end_time_seconds?: number;
  speaker_id?: string | number | null;
}

export interface RawSarvamBatchResult {
  request_id?: string;
  transcript?: string;
  language_code?: string | null;
  timestamps?: {
    chunks?: string[];
    /** Sarvam often returns chunk/sentence strings under `words` — not word-level. */
    words?: string[];
    start_time_seconds?: number[];
    end_time_seconds?: number[];
  } | null;
  diarized_transcript?: {
    entries?: RawSarvamDiarizedEntry[];
  } | null;
}

function toValidMs(seconds: number | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1000);
}

function speakerFromId(
  speakerId: string | number | null | undefined,
): { speakerTag: string; speakerNumericId: number | null } {
  if (speakerId === null || speakerId === undefined || speakerId === "") {
    return { speakerTag: "speaker_unknown", speakerNumericId: null };
  }
  const numeric = Number(speakerId);
  if (Number.isFinite(numeric)) {
    return { speakerTag: `Speaker ${numeric}`, speakerNumericId: numeric };
  }
  return { speakerTag: String(speakerId), speakerNumericId: null };
}

/**
 * Normalizes a Sarvam Batch STT JSON result into the provider-neutral contract.
 * Does not fabricate word timestamps (Batch returns chunk/segment timing only).
 */
export function normalizeSarvamBatchResult(
  raw: RawSarvamBatchResult,
  model: string,
  extraMetadata: Record<string, unknown> = {},
): TranscriptionResult {
  if (!raw || typeof raw !== "object") {
    throw new TranscriptionMalformedResponseError(
      "Sarvam transcription response was not a valid object.",
    );
  }

  const text =
    typeof raw.transcript === "string" ? raw.transcript.trim() : "";

  const diarizedEntries = raw.diarized_transcript?.entries;
  let segments: TranscriptionSegment[] = [];

  if (Array.isArray(diarizedEntries) && diarizedEntries.length > 0) {
    segments = diarizedEntries.flatMap((entry, i) => {
      const startMs = toValidMs(entry.start_time_seconds);
      const endMs = toValidMs(entry.end_time_seconds);
      if (startMs === null || endMs === null || endMs < startMs) return [];
      const { speakerTag, speakerNumericId } = speakerFromId(entry.speaker_id);
      return [
        {
          index: i,
          startMs,
          endMs,
          text: entry.transcript ?? "",
          confidence: null,
          speakerTag,
          speakerNumericId,
          language: raw.language_code ?? null,
          words: null,
        },
      ];
    });
  } else if (raw.timestamps) {
    // Sarvam Batch may label chunk arrays as `chunks` or `words` — neither is
    // true word-level timing; we still leave TranscriptionResult.words = null.
    const chunkTexts = Array.isArray(raw.timestamps.chunks)
      ? raw.timestamps.chunks
      : Array.isArray(raw.timestamps.words)
        ? raw.timestamps.words
        : null;
    const start_time_seconds = raw.timestamps.start_time_seconds;
    const end_time_seconds = raw.timestamps.end_time_seconds;
    if (
      chunkTexts &&
      Array.isArray(start_time_seconds) &&
      Array.isArray(end_time_seconds)
    ) {
      segments = chunkTexts.flatMap((chunk, i) => {
        const startMs = toValidMs(start_time_seconds[i]);
        const endMs = toValidMs(end_time_seconds[i]);
        if (startMs === null || endMs === null || endMs < startMs) return [];
        return [
          {
            index: i,
            startMs,
            endMs,
            text: chunk ?? "",
            confidence: null,
            speakerTag: "speaker_unknown",
            speakerNumericId: null,
            language: raw.language_code ?? null,
            words: null,
          },
        ];
      });
    }
  }

  if (segments.length === 0 && text.length > 0) {
    // Honest fallback: one undated segment — timestamps unavailable.
    segments = [
      {
        index: 0,
        startMs: 0,
        endMs: 0,
        text,
        confidence: null,
        speakerTag: "speaker_unknown",
        speakerNumericId: null,
        language: raw.language_code ?? null,
        words: null,
      },
    ];
  }

  if (text.length === 0 || segments.length === 0) {
    throw new TranscriptionEmptyTranscriptError(
      "Sarvam transcription returned empty text or zero usable segments.",
    );
  }

  const speakers = Array.from(
    new Set(
      segments
        .map((s) => s.speakerNumericId)
        .filter((v): v is number => typeof v === "number"),
    ),
  ).sort((a, b) => a - b);

  const lastEnd = segments.reduce((max, s) => Math.max(max, s.endMs), 0);
  const durationSeconds = lastEnd > 0 ? lastEnd / 1000 : null;

  return {
    text,
    detectedLanguage: raw.language_code ?? null,
    durationSeconds,
    segments,
    words: null, // Batch API: chunk-level only — never fabricate word timestamps
    model,
    usage: {
      seconds: durationSeconds,
      cost: null,
    },
    providerMetadata: {
      task: "transcribe",
      model,
      apiMode: "batch",
      requestId: raw.request_id ?? null,
      speakers,
      speakerCount: speakers.length,
      wordTimestamps: false,
      chunkTimestamps: true,
      ...extraMetadata,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sarvam Saaras:v4 production provider using the Batch STT API.
 *
 * Sync REST is capped at ~30s; Apply Wizz meetings require Batch (up to 2h).
 * Original recordings are never mutated — callers pass a derived local file.
 */
export class SarvamTranscriptionProvider implements TranscriptionProvider {
  readonly name = "sarvam";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_SARVAM_MODEL,
    private readonly mode: string = DEFAULT_SARVAM_MODE,
    private readonly timeoutMs: number = DEFAULT_SARVAM_TIMEOUT_MS,
    private readonly pollIntervalMs: number = DEFAULT_SARVAM_POLL_INTERVAL_MS,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = SARVAM_BASE_URL,
  ) {}

  async transcribe(
    filePath: string,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const startedAt = new Date().toISOString();
    const bytes = await readFile(filePath);
    const filename = basename(filePath) || "audio.wav";
    const languageCode = options.language
      ? mapLanguageToSarvamCode(options.language)
      : "unknown";

    const jobId = await this.initiateJob(languageCode);
    await this.uploadFile(jobId, filename, bytes);
    await this.startJob(jobId);
    const status = await this.pollUntilComplete(jobId);
    const raw = await this.downloadResult(jobId, status);
    return normalizeSarvamBatchResult(raw, this.model, {
      apiMode: "batch",
      mode: this.mode,
      languageCodeRequested: languageCode,
      executedAt: startedAt,
      jobId,
      sourceFileName: filename,
      diarization: true,
      timestamps: "chunk",
    });
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {
      "api-subscription-key": this.apiKey,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async initiateJob(languageCode: string): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/speech-to-text/job/v1`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        job_parameters: {
          model: this.model,
          mode: this.mode,
          language_code: languageCode,
          with_timestamps: true,
          with_diarization: true,
        },
      }),
    });
    await this.throwIfBadResponse(response, "initiate");
    const body = (await response.json().catch(() => null)) as {
      job_id?: string;
    } | null;
    if (!body?.job_id) {
      throw new TranscriptionMalformedResponseError(
        "Sarvam job initiate response did not include job_id.",
      );
    }
    return body.job_id;
  }

  private async uploadFile(
    jobId: string,
    filename: string,
    bytes: Buffer,
  ): Promise<void> {
    const linksRes = await this.fetchImpl(
      `${this.baseUrl}/speech-to-text/job/v1/upload-files`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ job_id: jobId, files: [filename] }),
      },
    );
    await this.throwIfBadResponse(linksRes, "upload-links");
    const linksBody = (await linksRes.json().catch(() => null)) as {
      upload_urls?: Record<string, { file_url?: string }>;
    } | null;
    const fileUrl = linksBody?.upload_urls?.[filename]?.file_url;
    if (!fileUrl) {
      throw new TranscriptionMalformedResponseError(
        "Sarvam upload-files response did not include a file_url.",
      );
    }

    const putRes = await this.fetchImpl(fileUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-ms-blob-type": "BlockBlob",
      },
      body: new Uint8Array(bytes),
    });
    if (!putRes.ok) {
      throw new TranscriptionApiError(
        putRes.status,
        `Sarvam audio upload failed with status ${putRes.status}.`,
      );
    }
  }

  private async startJob(jobId: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/speech-to-text/job/v1/${encodeURIComponent(jobId)}/start`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );
    await this.throwIfBadResponse(response, "start");
  }

  private async pollUntilComplete(jobId: string): Promise<{
    job_state?: string;
    job_details?: Array<{
      outputs?: Array<{ file_name?: string }>;
      state?: string;
      error_message?: string | null;
    }>;
    error_message?: string;
  }> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const response = await this.fetchImpl(
        `${this.baseUrl}/speech-to-text/job/v1/${encodeURIComponent(jobId)}/status`,
        {
          method: "GET",
          headers: this.headers(),
        },
      );
      await this.throwIfBadResponse(response, "status");
      const body = (await response.json().catch(() => null)) as {
        job_state?: string;
        job_details?: Array<{
          outputs?: Array<{ file_name?: string }>;
          state?: string;
          error_message?: string | null;
        }>;
        error_message?: string;
      } | null;
      if (!body?.job_state) {
        throw new TranscriptionMalformedResponseError(
          "Sarvam status response missing job_state.",
        );
      }
      if (body.job_state === "Completed") {
        return body;
      }
      if (body.job_state === "Failed") {
        throw new TranscriptionApiError(
          500,
          `Sarvam batch job failed${body.error_message ? `: ${body.error_message}` : "."}`,
        );
      }
      await sleep(this.pollIntervalMs);
    }
    throw new TranscriptionTimeoutError();
  }

  private async downloadResult(
    jobId: string,
    status: {
      job_details?: Array<{
        outputs?: Array<{ file_name?: string }>;
      }>;
    },
  ): Promise<RawSarvamBatchResult> {
    const outputName =
      status.job_details?.[0]?.outputs?.[0]?.file_name ?? "0.json";

    let fileUrl: string | undefined;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await sleep(1_000 * attempt);
      }
      const linksRes = await this.fetchImpl(
        `${this.baseUrl}/speech-to-text/job/v1/download-files`,
        {
          method: "POST",
          headers: this.headers(true),
          body: JSON.stringify({ job_id: jobId, files: [outputName] }),
        },
      );
      lastStatus = linksRes.status;
      if (linksRes.ok) {
        const linksBody = (await linksRes.json().catch(() => null)) as {
          download_urls?: Record<string, { file_url?: string }>;
        } | null;
        fileUrl = linksBody?.download_urls?.[outputName]?.file_url;
        if (fileUrl) break;
      } else if (linksRes.status !== 400 && linksRes.status !== 404) {
        await this.throwIfBadResponse(linksRes, "download-links");
      }
    }
    if (!fileUrl) {
      if (lastStatus && lastStatus !== 200) {
        throw new TranscriptionApiError(
          lastStatus,
          `Sarvam download-links failed with status ${lastStatus}.`,
        );
      }
      throw new TranscriptionMalformedResponseError(
        "Sarvam download-files response did not include a file_url.",
      );
    }
    const fileRes = await this.fetchImpl(fileUrl);
    if (!fileRes.ok) {
      throw new TranscriptionApiError(
        fileRes.status,
        `Sarvam result download failed with status ${fileRes.status}.`,
      );
    }
    const raw = (await fileRes.json().catch(() => null)) as RawSarvamBatchResult | null;
    if (!raw || typeof raw !== "object") {
      throw new TranscriptionMalformedResponseError(
        "Sarvam result file was not valid JSON.",
      );
    }
    return raw;
  }

  private async throwIfBadResponse(
    response: Response,
    stage: string,
  ): Promise<void> {
    if (response.ok || response.status === 202) return;
    if (response.status === 401 || response.status === 403) {
      throw new TranscriptionAuthError(
        response.status,
        `Sarvam authentication failed during ${stage} (${response.status}).`,
      );
    }
    if (response.status === 429) {
      throw new TranscriptionRateLimitError(
        response.status,
        `Sarvam rate limit exceeded during ${stage}.`,
      );
    }
    throw new TranscriptionApiError(
      response.status,
      `Sarvam ${stage} failed with status ${response.status}.`,
    );
  }
}

/** Map loose ISO-ish codes into Sarvam BCP-47 when callers force a language. */
export function mapLanguageToSarvamCode(language: string): string {
  const normalized = language.trim().toLowerCase();
  const map: Record<string, string> = {
    en: "en-IN",
    "en-in": "en-IN",
    "en-us": "en-IN",
    hi: "hi-IN",
    "hi-in": "hi-IN",
    te: "te-IN",
    "te-in": "te-IN",
    ta: "ta-IN",
    kn: "kn-IN",
    ml: "ml-IN",
    mr: "mr-IN",
    bn: "bn-IN",
    gu: "gu-IN",
    pa: "pa-IN",
    unknown: "unknown",
  };
  return map[normalized] ?? language;
}
