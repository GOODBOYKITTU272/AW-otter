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
  model: string | null;
  outcome: "accepted" | "failed";
  failureCode?: ProviderFailureCode;
}

export interface ExecuteTranscriptionWithFallbackInput {
  primaryProvider?: TranscriptionProvider;
  fallbackProvider?: TranscriptionProvider;
  providers?: TranscriptionProvider[];
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
 * Executes transcription with bounded per-provider retries and deterministic fallback chain.
 * Policy:
 * 1. For each provider in the chain:
 *    a. Attempt 1.
 *       - If success & non-empty: ACCEPTED.
 *       - If retryable failure (TIMEOUT, RATE_LIMIT, 5XX, UNAVAILABLE): Attempt 2 (bounded immediate retry).
 *       - If non-retryable failure (AUTH_FAILURE, etc.): Skip retry, proceed to next provider.
 *    b. If both attempts fail or non-retryable: Next provider.
 * 2. If all providers exhausted: throw AllTranscriptionProvidersFailedError with full attempt history.
 *
 * Supports both:
 * - Legacy API: primaryProvider + optional fallbackProvider (2-slot chain)
 * - New API: providers array (1-3 providers, ordered)
 */
export async function executeTranscriptionWithFallback(
  input: ExecuteTranscriptionWithFallbackInput,
): Promise<ExecuteTranscriptionWithFallbackResult> {
  const attempts: ProviderAttemptRecord[] = [];
  let fallbackReason: string | null = null;
  let lastError: unknown = null;

  const { primaryProvider, fallbackProvider, providers, filePath, options } = input;

  // Normalize to provider chain
  let providerChain: TranscriptionProvider[];
  if (providers && providers.length > 0) {
    providerChain = providers;
  } else if (primaryProvider) {
    providerChain = fallbackProvider ? [primaryProvider, fallbackProvider] : [primaryProvider];
  } else {
    throw new Error("Either providers array or primaryProvider must be specified");
  }

  // Iterate through provider chain
  for (let providerIndex = 0; providerIndex < providerChain.length; providerIndex++) {
    const provider = providerChain[providerIndex]!;
    const isLastProvider = providerIndex === providerChain.length - 1;

    // --- Attempt 1 for current provider ---
    let attempt1FailureCode: ProviderFailureCode | null = null;

    try {
      const res = await provider.transcribe(filePath, options);
      validateTranscriptionResult(res);
      attempts.push({
        sequence: attempts.length + 1,
        provider: provider.name,
        model: res.model,
        outcome: "accepted",
      });
      return {
        result: res,
        acceptedProvider: provider,
        attempts,
        fallbackReason,
      };
    } catch (err) {
      lastError = err;
      attempt1FailureCode = classifyProviderFailure(err);
      attempts.push({
        sequence: attempts.length + 1,
        provider: provider.name,
        model: null,
        outcome: "failed",
        failureCode: attempt1FailureCode,
      });
    }

    // --- Attempt 2 (Bounded immediate retry if retryable) ---
    if (attempt1FailureCode && isRetryableProviderFailure(attempt1FailureCode)) {
      try {
        const res = await provider.transcribe(filePath, options);
        validateTranscriptionResult(res);
        attempts.push({
          sequence: attempts.length + 1,
          provider: provider.name,
          model: res.model,
          outcome: "accepted",
        });
        return {
          result: res,
          acceptedProvider: provider,
          attempts,
          fallbackReason,
        };
      } catch (err) {
        lastError = err;
        const failureCode = classifyProviderFailure(err);
        attempts.push({
          sequence: attempts.length + 1,
          provider: provider.name,
          model: null,
          outcome: "failed",
          failureCode,
        });
        if (!isLastProvider) {
          fallbackReason = `Provider ${provider.name} failed after 2 attempts. Final error: ${failureCode}. Trying next provider.`;
        }
      }
    } else if (!isLastProvider) {
      // Non-retryable failure -> proceed to next provider
      fallbackReason = `Provider ${provider.name} encountered non-retryable error: ${attempt1FailureCode}. Trying next provider.`;
    }
  }

  // All providers exhausted
  throw new AllTranscriptionProvidersFailedError(attempts, fallbackReason, lastError);
}
