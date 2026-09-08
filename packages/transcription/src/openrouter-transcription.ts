import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
} from "./config";
import {
  TranscriptionApiError,
  TranscriptionMalformedResponseError,
  TranscriptionTimeoutError,
} from "./errors";
import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionWord,
} from "./types";

interface RawVerboseJsonSegment {
  id?: number;
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
}

interface RawVerboseJsonWord {
  word?: string;
  start?: number;
  end?: number;
}

interface RawVerboseJsonResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: RawVerboseJsonSegment[];
  words?: RawVerboseJsonWord[];
  usage?: { seconds?: number; cost?: number };
}

/** Returns null (never a fabricated 0) for a missing/non-finite/negative value — the caller decides whether that makes the segment unusable. */
function toValidMs(seconds: number | undefined): number | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1000);
}

/** avg_logprob is a negative log-probability, not a 0-1 confidence — this is a simple, documented monotonic mapping, not a calibrated probability. */
function logprobToConfidence(avgLogprob: number | undefined): number | null {
  if (avgLogprob === undefined) return null;
  return Math.max(0, Math.min(1, 1 + avgLogprob / 5));
}

function normalizeResponse(
  raw: RawVerboseJsonResponse,
  model: string,
): TranscriptionResult {
  if (typeof raw.text !== "string" || !Array.isArray(raw.segments)) {
    throw new TranscriptionMalformedResponseError(
      "OpenRouter transcription response did not include the expected text/segments fields.",
    );
  }

  // Codex post-implementation review (SHOULD-FIX): a provider that returns
  // missing/negative/non-finite/reversed timestamps would previously
  // persist as malformed evidence (e.g. toMs(undefined) silently became
  // 0). Segments with unusable timestamps are dropped entirely — never
  // coerced to a fabricated value — rather than corrupting the evidence
  // record; the original array index is kept as `index` even across a
  // drop, so ordering/gaps stay meaningful.
  const segments: TranscriptionSegment[] = raw.segments.flatMap((s, i) => {
    const startMs = toValidMs(s.start);
    const endMs = toValidMs(s.end);
    if (startMs === null || endMs === null || endMs < startMs) return [];
    return [
      {
        index: i,
        startMs,
        endMs,
        text: s.text ?? "",
        confidence: logprobToConfidence(s.avg_logprob),
      },
    ];
  });

  const words: TranscriptionWord[] | null = Array.isArray(raw.words)
    ? raw.words.flatMap((w) => {
        const startMs = toValidMs(w.start);
        const endMs = toValidMs(w.end);
        if (startMs === null || endMs === null || endMs < startMs) return [];
        return [{ word: w.word ?? "", startMs, endMs }];
      })
    : null;

  return {
    text: raw.text,
    detectedLanguage: raw.language ?? null,
    durationSeconds: raw.duration ?? null,
    segments,
    words,
    model,
    usage: {
      seconds: raw.usage?.seconds ?? null,
      cost: raw.usage?.cost ?? null,
    },
    providerMetadata: { task: "transcribe", model },
  };
}

const EXTENSION_MIME: Record<string, string> = {
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

function guessMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

/**
 * OpenRouter's Whisper-backed STT endpoint, verified live (readiness
 * investigation, 2026-09-08): real endpoint, real auth, verbose_json with
 * both segment and word timestamps confirmed present. filePath must
 * already be a clean, transcodable file — this class never fetches or
 * transcodes, matching the provider-neutral contract (see types.ts).
 */
export class OpenRouterTranscriptionProvider implements TranscriptionProvider {
  readonly name = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_TRANSCRIPTION_MODEL,
    private readonly timeoutMs: number = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(
    filePath: string,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.set("model", this.model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (options.language) form.set("language", options.language);
    form.set(
      "file",
      new Blob([new Uint8Array(bytes)], { type: guessMimeType(filePath) }),
      basename(filePath),
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${OPENROUTER_BASE_URL}/audio/transcriptions`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          body: form,
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TranscriptionTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    // Never log/include the response body in a thrown error — it can
    // contain the customer's own spoken content.
    if (!response.ok) {
      throw new TranscriptionApiError(
        response.status,
        `OpenRouter transcription request failed with status ${response.status}.`,
      );
    }

    const body = await response.json().catch(() => null);
    if (body === null || typeof body !== "object") {
      throw new TranscriptionMalformedResponseError(
        "OpenRouter transcription response was not valid JSON.",
      );
    }

    return normalizeResponse(body as RawVerboseJsonResponse, this.model);
  }
}
