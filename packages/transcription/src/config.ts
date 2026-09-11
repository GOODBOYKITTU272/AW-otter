export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Verified working against the real endpoint (readiness investigation,
 * 2026-09-08): verbose_json, segment AND word timestamps, language
 * detection, usage/cost all confirmed present. English quality: clean.
 * Telugu/Telugu-English quality: measurably poor on synthetic TTS speech —
 * NOT yet validated against real human speech (M8 shipping gate, not an
 * implementation blocker).
 *
 * Switched to the -turbo variant for the next real controlled test
 * (feasibility spike, 2026-09-10): same OpenRouter endpoint/request
 * shape, same verbose_json response contract — this is a pure model-string
 * swap through the existing constructor parameter, not a provider change.
 * `language` is still never forced (see transcription.ts's real call site
 * — no `options.language` passed), so this remains auto-detect, same as
 * before; the actual open question is whether -turbo's own auto-detection
 * handles English↔Telugu code-switching within one clip any better than
 * v3 did, which needs a real call to answer, not a guess.
 */
export const DEFAULT_TRANSCRIPTION_MODEL = "openai/whisper-large-v3-turbo";

/**
 * Not yet live-verified (model choice for the canonical-English
 * normalization stage needs its own real-call verification once the
 * rotated OpenRouter credential is available) — a reasonable default, not
 * a locked decision.
 */
export const DEFAULT_NORMALIZATION_MODEL = "openai/gpt-4o-mini";

/** A ~1MB compressed real meeting recording round-tripped in ~5-10s during testing; generous headroom for a long real call. */
export const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;
export const DEFAULT_NORMALIZATION_TIMEOUT_MS = 30_000;

export const DEFAULT_AZURE_MAI_MODEL = "MAI-Transcribe-2";
export const DEFAULT_AZURE_MAI_API_VERSION = "2025-10-15";
export const DEFAULT_AZURE_MAI_TIMEOUT_MS = 180_000;
