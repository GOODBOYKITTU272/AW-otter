/** Non-2xx HTTP response from the STT/normalization provider. Message is always generic — never includes the raw response body (may contain transcript text). */
export class TranscriptionApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TranscriptionApiError";
    this.status = status;
  }
}

/** 2xx response whose body doesn't match the expected shape. */
export class TranscriptionMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionMalformedResponseError";
  }
}

export class TranscriptionTimeoutError extends Error {
  constructor() {
    super("Transcription provider request timed out.");
    this.name = "TranscriptionTimeoutError";
  }
}

export class TranscriptionAuthError extends TranscriptionApiError {
  constructor(
    status: number = 401,
    message: string = "Transcription provider authentication failed.",
  ) {
    super(status, message);
    this.name = "TranscriptionAuthError";
  }
}

export class TranscriptionRateLimitError extends TranscriptionApiError {
  constructor(
    status: number = 429,
    message: string = "Transcription provider rate limit exceeded.",
  ) {
    super(status, message);
    this.name = "TranscriptionRateLimitError";
  }
}

export class TranscriptionEmptyTranscriptError extends Error {
  constructor(
    message: string = "Transcription provider returned empty text or zero usable segments.",
  ) {
    super(message);
    this.name = "TranscriptionEmptyTranscriptError";
  }
}

export type ProviderFailureCode =
  | "AUTH_FAILURE"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROVIDER_5XX"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_AUDIO"
  | "EMPTY_TRANSCRIPT"
  | "PROVIDER_UNAVAILABLE"
  | "NON_RETRYABLE_PROVIDER_ERROR";

export function classifyProviderFailure(error: unknown): ProviderFailureCode {
  if (error instanceof TranscriptionAuthError) {
    return "AUTH_FAILURE";
  }
  if (error instanceof TranscriptionRateLimitError) {
    return "RATE_LIMIT";
  }
  if (error instanceof TranscriptionTimeoutError) {
    return "TIMEOUT";
  }
  if (error instanceof TranscriptionMalformedResponseError) {
    return "INVALID_RESPONSE";
  }
  if (error instanceof TranscriptionEmptyTranscriptError) {
    return "EMPTY_TRANSCRIPT";
  }
  if (error instanceof TranscriptionApiError) {
    const status = error.status;
    if (status === 401 || status === 403) return "AUTH_FAILURE";
    if (status === 429) return "RATE_LIMIT";
    if (status >= 500 && status <= 599) return "PROVIDER_5XX";
    if (status === 415) return "UNSUPPORTED_AUDIO";
    if (status === 400 || status === 422) return "INVALID_RESPONSE";
    return "NON_RETRYABLE_PROVIDER_ERROR";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.message.includes("timed out")) {
      return "TIMEOUT";
    }
    const code = (error as { code?: string }).code;
    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      code === "ECONNRESET" ||
      error.message.includes("fetch failed")
    ) {
      return "PROVIDER_UNAVAILABLE";
    }
  }
  return "NON_RETRYABLE_PROVIDER_ERROR";
}

export function isRetryableProviderFailure(code: ProviderFailureCode): boolean {
  switch (code) {
    case "TIMEOUT":
    case "RATE_LIMIT":
    case "PROVIDER_5XX":
    case "PROVIDER_UNAVAILABLE":
      return true;
    case "AUTH_FAILURE":
    case "INVALID_RESPONSE":
    case "EMPTY_TRANSCRIPT":
    case "UNSUPPORTED_AUDIO":
    case "NON_RETRYABLE_PROVIDER_ERROR":
      return false;
  }
}

export function validateTranscriptionResult(result: {
  text?: string | null;
  segments?: unknown[] | null;
}): void {
  if (!result || typeof result.text !== "string" || result.text.trim().length === 0) {
    throw new TranscriptionEmptyTranscriptError(
      "Transcription provider returned empty text.",
    );
  }
  if (!Array.isArray(result.segments) || result.segments.length === 0) {
    throw new TranscriptionEmptyTranscriptError(
      "Transcription provider returned zero usable segments.",
    );
  }
}
