interface VexaErrorBody {
  detail?: string;
  message?: string;
  error?: { message?: string } | string;
}

export class VexaAuthError extends Error {
  constructor(message = "Vexa rejected the request's credentials.") {
    super(message);
    this.name = "VexaAuthError";
  }
}

export class VexaRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("Vexa rate limit exceeded.");
    this.name = "VexaRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class VexaApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VexaApiError";
    this.status = status;
  }
}

/** Maps a failed Vexa HTTP response onto a typed error. Never includes API keys. */
export function normalizeVexaError(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): Error {
  const parsed = (body ?? {}) as VexaErrorBody;
  const message =
    parsed.detail ??
    parsed.message ??
    (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ??
    `Vexa request failed with status ${status}.`;

  if (status === 401 || status === 403) return new VexaAuthError(message);
  if (status === 429) {
    const retryAfter = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : null;
    return new VexaRateLimitError(
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return new VexaApiError(status, message);
}
