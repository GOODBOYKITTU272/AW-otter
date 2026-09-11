import { readFile } from "node:fs/promises";
// computeWer
// computeCer

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

export interface MaiWordTimestamp {
  word: string;
  offsetMs: number;
  durationMs: number;
}

export interface MaiSegment {
  text: string;
  offsetMs: number;
  durationMs: number;
  speaker?: string;
  words?: MaiWordTimestamp[];
}

export interface MaiResponse {
  combinedPhrases?: { text: string }[];
  phrases?: {
    text: string;
    offsetMs: number;
    durationMs: number;
    speaker?: string;
    words?: { word: string; offsetMs: number; durationMs: number }[];
    locale?: string;
  }[];
  durationMs?: number;
}

export async function transcribeWithMai(
  audioPath: string,
  options: MaiTranscribeOptions
): Promise<{ text: string; raw: MaiResponse; elapsedMs: number; detectedLocale?: string }> {
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

  const data = (await res.json()) as MaiResponse;
  const text =
    data.combinedPhrases?.map((p) => p.text).join(" ") ||
    data.phrases?.map((p) => p.text).join(" ") ||
    "";
  const detectedLocale = data.phrases?.[0]?.locale;

  return {
    text,
    raw: data,
    elapsedMs,
    detectedLocale,
  };
}
