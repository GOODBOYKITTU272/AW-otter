export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Structured-extraction model choice: configuration, not domain logic
 * (M9 correction #6 — "do not spend time optimizing model vendors right
 * now... choose an appropriate model through configuration"). gpt-4o over
 * the gpt-4o-mini used for M8's lighter normalization step, since this is
 * multi-field discriminated-union extraction across 5 call types, not
 * single-string cleanup. Swappable later without touching domain logic —
 * packages/domain only depends on the MeetingIntelligenceProvider
 * interface (src/types.ts), never this constant directly.
 */
export const DEFAULT_INTELLIGENCE_MODEL = "openai/gpt-4o";

/**
 * Identity-tuple components (M9 correction #2 — idempotency must not
 * depend on the model correctly recognizing anything; it depends on this
 * being deterministic and bumped only on a deliberate change).
 * `ai_runs`'s unique constraint is (meeting_id, transcript_id, run_type,
 * model, prompt_version, provider_config_version) — bump prompt_version
 * when the prompt template changes; bump provider_config_version when
 * anything else about the call configuration changes (temperature,
 * response_format, schema version). A worker retry after a crash reuses
 * the SAME row (same identity) via the retryable/next_retry_at state
 * machine already established by meeting_transcripts — it never inserts a
 * duplicate.
 */
export const CURRENT_PROMPT_VERSION = "v1";
export const CURRENT_PROVIDER_CONFIG_VERSION = "v1";
export const MEETING_INTELLIGENCE_RUN_TYPE = "meeting_intelligence";

export const DEFAULT_INTELLIGENCE_TIMEOUT_MS = 120_000;

/**
 * M13 §9: Ask Signal is the first synchronous, user-request-blocking AI
 * call in the codebase (M9 is a background queue worker) — a much shorter
 * timeout budget than M9's 120s, and a faster/cheaper model since it only
 * synthesizes over an already-retrieved, already-bounded evidence bundle
 * rather than extracting structure from a full transcript.
 */
export const DEFAULT_ASK_SIGNAL_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_ASK_SIGNAL_TIMEOUT_MS = 30_000;
