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
