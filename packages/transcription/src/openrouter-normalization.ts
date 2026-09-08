import {
  DEFAULT_NORMALIZATION_MODEL,
  DEFAULT_NORMALIZATION_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
} from "./config";
import {
  TranscriptionApiError,
  TranscriptionMalformedResponseError,
  TranscriptionTimeoutError,
} from "./errors";
import type { EnglishNormalizationProvider, NormalizeResult } from "./types";

const SYSTEM_PROMPT = `You translate spoken meeting transcript segments into natural, meaning-preserving English.

Rules:
- Preserve the speaker's actual intent and meaning, not a literal word-for-word translation.
- The input may mix the source language with English technical/business terms (code-switching) — keep those English terms as-is.
- Output ONLY the natural English sentence. No commentary, no quotes, no explanation.
- If the input is empty or unintelligible, output exactly: [unintelligible]`;

interface RawChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Deliberately a SEPARATE call/model from OpenRouterTranscriptionProvider
 * (locked architecture: transcription and semantic normalization are
 * separate stages) — Whisper transcribes, a chat model produces the
 * meaning-preserving canonical English layer. Model choice
 * (DEFAULT_NORMALIZATION_MODEL) has not yet been live-verified — that's
 * part of what a rotated credential unblocks.
 */
export class OpenRouterNormalizationProvider implements EnglishNormalizationProvider {
  readonly name = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_NORMALIZATION_MODEL,
    private readonly timeoutMs: number = DEFAULT_NORMALIZATION_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async normalize(
    text: string,
    sourceLanguage: string | null,
  ): Promise<NormalizeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.2,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: `Source language: ${sourceLanguage ?? "unknown"}\nOriginal: ${text}`,
              },
            ],
          }),
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

    if (!response.ok) {
      throw new TranscriptionApiError(
        response.status,
        `OpenRouter normalization request failed with status ${response.status}.`,
      );
    }

    const body = (await response
      .json()
      .catch(() => null)) as RawChatCompletionResponse | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new TranscriptionMalformedResponseError(
        "OpenRouter normalization response did not include a usable message.",
      );
    }

    return {
      // No numeric confidence signal is available from a chat completion —
      // returning null (never fabricated) rather than a guessed number.
      canonicalEnglishText: content.trim(),
      confidence: null,
    };
  }
}
