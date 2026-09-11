import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  DEFAULT_AZURE_MAI_API_VERSION,
  DEFAULT_AZURE_MAI_MODEL,
  DEFAULT_AZURE_MAI_TIMEOUT_MS,
} from "./config";
import {
  TranscriptionApiError,
  TranscriptionAuthError,
  TranscriptionMalformedResponseError,
  TranscriptionRateLimitError,
  TranscriptionTimeoutError,
} from "./errors";
import type {
  TranscribeOptions,
  TranscriptionProvider,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionWord,
} from "./types";

export interface RawAzureMaiWord {
  text?: string;
  offsetMilliseconds?: number;
  durationMilliseconds?: number;
}

export interface RawAzureMaiPhrase {
  text?: string;
  offsetMilliseconds?: number;
  durationMilliseconds?: number;
  speaker?: number | string | null;
  words?: RawAzureMaiWord[];
  locale?: string;
  confidence?: number;
}

export interface RawAzureMaiResponse {
  durationMilliseconds?: number;
  combinedPhrases?: { text: string }[];
  phrases?: RawAzureMaiPhrase[];
}

function toValidMs(ms: number | undefined): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return Math.round(ms);
}

export function normalizeAzureMaiResponse(
  raw: RawAzureMaiResponse,
  model: string,
  extraMetadata: Record<string, unknown> = {},
): TranscriptionResult {
  if (!Array.isArray(raw.phrases)) {
    throw new TranscriptionMalformedResponseError(
      "Azure MAI transcription response did not include the expected phrases array.",
    );
  }

  const distinctSpeakerSet = new Set<number>();
  const globalWords: TranscriptionWord[] = [];

  const segments: TranscriptionSegment[] = raw.phrases.flatMap((p, i) => {
    const startMs = toValidMs(p.offsetMilliseconds);
    const durationMs = toValidMs(p.durationMilliseconds) ?? 0;
    if (startMs === null) return [];
    const endMs = startMs + durationMs;

    let speakerTag = "speaker_unknown";
    let speakerNumericId: number | null = null;

    if (p.speaker !== null && p.speaker !== undefined) {
      const num = Number(p.speaker);
      if (Number.isFinite(num)) {
        speakerNumericId = num;
        speakerTag = `Speaker ${num}`;
        distinctSpeakerSet.add(num);
      }
    }

    const segmentWords: TranscriptionWord[] = (p.words ?? []).flatMap((w) => {
      const wStart = toValidMs(w.offsetMilliseconds);
      const wDur = toValidMs(w.durationMilliseconds) ?? 0;
      if (wStart === null) return [];
      const wordObj: TranscriptionWord = {
        word: w.text ?? "",
        startMs: wStart,
        endMs: wStart + wDur,
      };
      globalWords.push(wordObj);
      return [wordObj];
    });

    return [
      {
        index: i,
        startMs,
        endMs,
        text: p.text ?? "",
        confidence: typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : null,
        speakerTag,
        speakerNumericId,
        language: p.locale ?? null,
        words: segmentWords,
      },
    ];
  });

  const fullText =
    raw.combinedPhrases?.map((cp) => cp.text).join(" ").trim() ||
    segments.map((s) => s.text).join(" ").trim();

  const sortedSpeakers = Array.from(distinctSpeakerSet).sort((a, b) => a - b);
  const detectedLocale = raw.phrases[0]?.locale ?? null;
  const durationSeconds =
    typeof raw.durationMilliseconds === "number" && Number.isFinite(raw.durationMilliseconds)
      ? raw.durationMilliseconds / 1000
      : null;

  return {
    text: fullText,
    detectedLanguage: detectedLocale,
    durationSeconds,
    segments,
    words: globalWords.length > 0 ? globalWords : null,
    model,
    usage: {
      seconds: durationSeconds,
      cost: null,
    },
    providerMetadata: {
      task: "transcribe",
      model,
      speakers: sortedSpeakers,
      speakerCount: sortedSpeakers.length,
      ...extraMetadata,
    },
  };
}

export class AzureMaiTranscriptionProvider implements TranscriptionProvider {
  readonly name = "azure-mai";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly region?: string,
    private readonly model: string = DEFAULT_AZURE_MAI_MODEL,
    private readonly apiVersion: string = DEFAULT_AZURE_MAI_API_VERSION,
    private readonly timeoutMs: number = DEFAULT_AZURE_MAI_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(
    filePath: string,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    const bytes = await readFile(filePath);
    const url = `${this.endpoint.replace(/\/$/, "")}/speechtotext/transcriptions:transcribe?api-version=${this.apiVersion}`;

    const definition: Record<string, unknown> = {
      enhancedMode: {
        enabled: true,
        model: this.model,
        modelOptions: {
          timestamps: "word",
          transcribeStyle: "verbatim",
        },
      },
      diarization: {
        enabled: true,
      },
    };

    if (options.language) {
      definition.locales = [options.language];
    }

    const form = new FormData();
    const filename = basename(filePath) || "audio.wav";
    form.append(
      "audio",
      new Blob([new Uint8Array(bytes)], { type: "audio/wav" }),
      filename,
    );
    form.append("definition", JSON.stringify(definition));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": this.apiKey,
        },
        body: form,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new TranscriptionTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new TranscriptionAuthError(
          response.status,
          `Azure MAI authentication failed with status ${response.status}.`,
        );
      }
      if (response.status === 429) {
        throw new TranscriptionRateLimitError(
          response.status,
          "Azure MAI rate limit exceeded (429).",
        );
      }
      throw new TranscriptionApiError(
        response.status,
        `Azure MAI transcription request failed with status ${response.status}.`,
      );
    }

    const body = (await response.json().catch(() => null)) as RawAzureMaiResponse | null;
    if (body === null || typeof body !== "object") {
      throw new TranscriptionMalformedResponseError(
        "Azure MAI transcription response was not valid JSON.",
      );
    }

    return normalizeAzureMaiResponse(body, this.model, {
      endpoint: this.endpoint,
      region: this.region,
      apiVersion: this.apiVersion,
      enhancedMode: true,
      diarization: true,
      timestamps: "word",
    });
  }
}
