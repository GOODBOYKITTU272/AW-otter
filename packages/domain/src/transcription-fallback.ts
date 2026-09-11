import {
  classifyProviderFailure,
  isRetryableProviderFailure,
  validateTranscriptionResult,
  type ProviderFailureCode,
  type TranscribeOptions,
  type TranscriptionProvider,
  type TranscriptionResult,
} from "@applywizz/transcription";

export interface ProviderAttemptRecord {
  sequence: number;
  provider: string;
  model: string;
  outcome: "accepted" | "failed";
  failureCode?: ProviderFailureCode;
}

export interface ExecuteTranscriptionWithFallbackInput {
  primaryProvider: TranscriptionProvider;
  fallbackProvider?: TranscriptionProvider;
  filePath: string;
  options?: TranscribeOptions;
}

export interface ExecuteTranscriptionWithFallbackResult {
  result: TranscriptionResult;
  acceptedProvider: TranscriptionProvider;
  attempts: ProviderAttemptRecord[];
  fallbackReason?: string | null;
}

export class AllTranscriptionProvidersFailedError extends Error {
  readonly attempts: ProviderAttemptRecord[];
  readonly fallbackReason: string | null;
  readonly lastError: unknown;

  constructor(
    attempts: ProviderAttemptRecord[],
    fallbackReason: string | null,
    lastError: unknown,
  ) {
    super("All transcription providers failed.");
    this.name = "AllTranscriptionProvidersFailedError";
    this.attempts = attempts;
    this.fallbackReason = fallbackReason;
    this.lastError = lastError;
  }
}

/**
 * Executes transcription with bounded primary retries and deterministic fallback.
 * Policy:
 * 1. Primary provider attempt 1.
 *    - If success & non-empty: ACCEPTED.
 *    - If retryable failure (TIMEOUT, RATE_LIMIT, 5XX, UNAVAILABLE): Primary attempt 2.
 *    - If non-retryable failure (AUTH_FAILURE, etc.): Proceed directly to fallback.
 * 2. If primary exhausted allowed retries or failed non-retryably:
 *    - Fallback provider attempt 1 (if configured).
 *    - If success & non-empty: ACCEPTED.
 *    - If failed: All providers failed.
 * Max provider calls per claimed job: 3.
 */
export async function executeTranscriptionWithFallback(
  input: ExecuteTranscriptionWithFallbackInput,
): Promise<ExecuteTranscriptionWithFallbackResult> {
  const attempts: ProviderAttemptRecord[] = [];
  let fallbackReason: string | null = null;
  let lastError: unknown = null;

  const { primaryProvider, fallbackProvider, filePath, options } = input;

  // --- Primary Attempt 1 ---
  let primarySuccessResult: TranscriptionResult | null = null;
  let primaryAttempt1FailureCode: ProviderFailureCode | null = null;

  try {
    const res = await primaryProvider.transcribe(filePath, options);
    validateTranscriptionResult(res);
    primarySuccessResult = res;
    attempts.push({
      sequence: 1,
      provider: primaryProvider.name,
      model: res.model,
      outcome: "accepted",
    });
  } catch (err) {
    lastError = err;
    primaryAttempt1FailureCode = classifyProviderFailure(err);
    attempts.push({
      sequence: 1,
      provider: primaryProvider.name,
      model: primaryProvider.name,
      outcome: "failed",
      failureCode: primaryAttempt1FailureCode,
    });
  }

  if (primarySuccessResult) {
    return {
      result: primarySuccessResult,
      acceptedProvider: primaryProvider,
      attempts,
      fallbackReason: null,
    };
  }

  // --- Primary Attempt 2 (Bounded immediate retry if retryable) ---
  if (primaryAttempt1FailureCode && isRetryableProviderFailure(primaryAttempt1FailureCode)) {
    try {
      const res = await primaryProvider.transcribe(filePath, options);
      validateTranscriptionResult(res);
      attempts.push({
        sequence: 2,
        provider: primaryProvider.name,
        model: res.model,
        outcome: "accepted",
      });
      return {
        result: res,
        acceptedProvider: primaryProvider,
        attempts,
        fallbackReason: null,
      };
    } catch (err) {
      lastError = err;
      const failureCode = classifyProviderFailure(err);
      attempts.push({
        sequence: 2,
        provider: primaryProvider.name,
        model: primaryProvider.name,
        outcome: "failed",
        failureCode,
      });
      fallbackReason = `Primary provider ${primaryProvider.name} failed after 2 attempts. Final error: ${failureCode}`;
    }
  } else {
    // Non-retryable primary failure (e.g. AUTH_FAILURE) -> skip attempt 2
    fallbackReason = `Primary provider ${primaryProvider.name} encountered non-retryable error: ${primaryAttempt1FailureCode}`;
  }

  // --- Fallback Attempt 1 ---
  if (fallbackProvider) {
    try {
      const res = await fallbackProvider.transcribe(filePath, options);
      validateTranscriptionResult(res);
      attempts.push({
        sequence: attempts.length + 1,
        provider: fallbackProvider.name,
        model: res.model,
        outcome: "accepted",
      });
      return {
        result: res,
        acceptedProvider: fallbackProvider,
        attempts,
        fallbackReason,
      };
    } catch (err) {
      lastError = err;
      const failureCode = classifyProviderFailure(err);
      attempts.push({
        sequence: attempts.length + 1,
        provider: fallbackProvider.name,
        model: fallbackProvider.name,
        outcome: "failed",
        failureCode,
      });
    }
  }

  throw new AllTranscriptionProvidersFailedError(attempts, fallbackReason, lastError);
}
