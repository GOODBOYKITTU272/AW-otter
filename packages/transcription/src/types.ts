/** Normalized segment shape — provider-neutral, matches transcript_segments' own columns. */
export interface TranscriptionSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  /** Per-segment confidence if the provider supplies one (e.g. Whisper's avg_logprob-derived value); null if not available. */
  confidence: number | null;
  /** Raw provider speaker tag (e.g. "Speaker 0", "Speaker 1"). Null/undefined if diarization unavailable. */
  speakerTag?: string | null;
  /** Raw provider numeric speaker ID if reported (e.g. 0, 1). */
  speakerNumericId?: number | null;
  /** Per-segment word-level timestamps if supported/available. */
  words?: TranscriptionWord[] | null;
}

export interface TranscriptionWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscriptionResult {
  /** Full concatenated original-language text. */
  text: string;
  /** ISO-639-1-ish code as the provider reports it (e.g. "en", "hi") — never assumed accurate, just recorded. */
  detectedLanguage: string | null;
  durationSeconds: number | null;
  segments: TranscriptionSegment[];
  /** Null when word-level timestamps weren't requested/returned — never fabricated from segment timestamps. */
  words: TranscriptionWord[] | null;
  model: string;
  usage: {
    seconds: number | null;
    cost: number | null;
  };
  /** Provider response metadata safe to keep (task/model/etc) — never raw auth headers, never the full original response body verbatim if it could contain more than this. */
  providerMetadata: Record<string, unknown>;
}

export interface TranscribeOptions {
  /** ISO-639-1 code to force; omit to let the provider auto-detect. */
  language?: string;
}

/**
 * Provider-neutral transcription contract (locked M8 architecture: "Domain
 * code must not depend on OpenRouter types"). filePath must already be a
 * clean, provider-compatible local file — this contract does not fetch or
 * transcode; that's the domain layer's job (packages/domain/src/
 * audio-transcode.ts + transcription.ts).
 */
export interface TranscriptionProvider {
  readonly name: string;
  transcribe(
    filePath: string,
    options?: TranscribeOptions,
  ): Promise<TranscriptionResult>;
}

export interface NormalizeResult {
  canonicalEnglishText: string;
  /** 0-1 confidence signal — null if the provider gives no usable signal (never fabricated). */
  confidence: number | null;
}

/**
 * Kept as a SEPARATE contract from TranscriptionProvider (locked
 * architecture: "keep transcription and semantic normalization as separate
 * stages/contracts") — Whisper transcribes, this produces the
 * meaning-preserving canonical English layer. Only ever called for
 * non-English/code-switched segments; a clean English segment's
 * original_text IS its canonical English (see transcription.ts).
 */
export interface EnglishNormalizationProvider {
  readonly name: string;
  normalize(
    text: string,
    sourceLanguage: string | null,
  ): Promise<NormalizeResult>;
}
