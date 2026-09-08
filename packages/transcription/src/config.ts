export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Verified working against the real endpoint (readiness investigation,
 * 2026-09-08): verbose_json, segment AND word timestamps, language
 * detection, usage/cost all confirmed present. English quality: clean.
 * Telugu/Telugu-English quality: measurably poor on synthetic TTS speech —
 * NOT yet validated against real human speech (M8 shipping gate, not an
 * implementation blocker).
 */
export const DEFAULT_TRANSCRIPTION_MODEL = "openai/whisper-large-v3";

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
