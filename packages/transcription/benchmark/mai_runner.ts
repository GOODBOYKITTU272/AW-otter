import { readFile } from "node:fs/promises";

export interface MaiTranscribeOptions {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
  enhancedMode?: boolean;
  model?: string;
  diarization?: boolean;
  locales?: string[];
  phrases?: string[];
}

/** Raw shape emitted by Azure speechtotext/transcriptions:transcribe API */
export interface RawAzureMaiWord {
  text: string;
  offsetMilliseconds: number;
  durationMilliseconds: number;
}

export interface RawAzureMaiPhrase {
  text: string;
  offsetMilliseconds: number;
  durationMilliseconds: number;
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

/** Normalized shape used by Signal benchmark evaluation */
export interface NormalizedBenchmarkWord {
  word: string;
  startMs: number;
  durationMs: number;
  endMs: number;
}

export interface NormalizedBenchmarkPhrase {
  text: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  speakerTag: string; // e.g. "Speaker 0", "Speaker 1", "speaker_unknown"
  speakerNumericId: number | null;
  locale?: string;
  words: NormalizedBenchmarkWord[];
}

export interface NormalizedBenchmarkResult {
  text: string;
  durationMs: number;
  phrases: NormalizedBenchmarkPhrase[];
  speakers: number[];
  speakerCount: number;
  detectedLocale?: string;
  elapsedMs: number;
  raw: RawAzureMaiResponse;
}

/**
 * Normalizes Azure's raw API response (preserving speaker 0, converting milliseconds,
 * extracting distinct numeric speakers safely without falsy-dropping 0).
 */
export function normalizeAzureMaiResponse(
  raw: RawAzureMaiResponse,
  elapsedMs: number
): NormalizedBenchmarkResult {
  const durationMs = raw.durationMilliseconds ?? 0;
  const rawPhrases = raw.phrases ?? [];

  const distinctSpeakerSet = new Set<number>();

  const normalizedPhrases: NormalizedBenchmarkPhrase[] = rawPhrases.map((p) => {
    const startMs = p.offsetMilliseconds ?? 0;
    const duration = p.durationMilliseconds ?? 0;
    const endMs = startMs + duration;

    let speakerTag = "speaker_unknown";
    let speakerNum: number | null = null;

    if (p.speaker !== null && p.speaker !== undefined) {
      const num = Number(p.speaker);
      if (Number.isFinite(num)) {
        speakerNum = num;
        speakerTag = `Speaker ${num}`;
        distinctSpeakerSet.add(num);
      }
    }

    const words: NormalizedBenchmarkWord[] = (p.words ?? []).map((w) => ({
      word: w.text ?? "",
      startMs: w.offsetMilliseconds ?? 0,
      durationMs: w.durationMilliseconds ?? 0,
      endMs: (w.offsetMilliseconds ?? 0) + (w.durationMilliseconds ?? 0),
    }));

    return {
      text: p.text ?? "",
      startMs,
      durationMs: duration,
      endMs,
      speakerTag,
      speakerNumericId: speakerNum,
      locale: p.locale,
      words,
    };
  });

  const fullText =
    raw.combinedPhrases?.map((cp) => cp.text).join(" ").trim() ||
    normalizedPhrases.map((np) => np.text).join(" ").trim() ||
    "";

  const sortedSpeakers = Array.from(distinctSpeakerSet).sort((a, b) => a - b);

  return {
    text: fullText,
    durationMs,
    phrases: normalizedPhrases,
    speakers: sortedSpeakers,
    speakerCount: sortedSpeakers.length,
    detectedLocale: normalizedPhrases[0]?.locale,
    elapsedMs,
    raw,
  };
}

export async function transcribeWithMai(
  audioPath: string,
  options: MaiTranscribeOptions
): Promise<NormalizedBenchmarkResult> {
  const audioBytes = await readFile(audioPath);
  const apiVersion = options.apiVersion || "2025-10-15";
  const url = `${options.endpoint.replace(/\/$/, "")}/speechtotext/transcriptions:transcribe?api-version=${apiVersion}`;

  const definition: Record<string, unknown> = {};

  if (options.enhancedMode) {
    definition.enhancedMode = {
      enabled: true,
      model: options.model || "MAI-Transcribe-2",
      modelOptions: {
        timestamps: "word",
        transcribeStyle: "verbatim",
      },
    };
  }

  if (options.diarization) {
    definition.diarization = {
      enabled: true,
    };
  }

  if (options.locales && options.locales.length > 0) {
    definition.locales = options.locales;
  }

  if (options.phrases && options.phrases.length > 0) {
    definition.phraseDetection = {
      mode: "Conversation",
      phrases: options.phrases,
    };
  }

  const form = new FormData();
  form.append("audio", new Blob([audioBytes], { type: "audio/wav" }), "audio.wav");
  form.append("definition", JSON.stringify(definition));

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": options.apiKey,
    },
    body: form,
  });
  const elapsedMs = Date.now() - start;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`MAI request failed with status ${res.status}: ${errText}`);
  }

  const raw = (await res.json()) as RawAzureMaiResponse;
  return normalizeAzureMaiResponse(raw, elapsedMs);
}
