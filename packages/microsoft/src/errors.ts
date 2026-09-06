interface GraphErrorBody {
  error?: { code?: string; message?: string };
}

export class GraphAuthError extends Error {
  constructor(message = "Microsoft rejected the request's credentials.") {
    super(message);
    this.name = "GraphAuthError";
  }
}

export class GraphRateLimitError extends Error {
  readonly retryAfterSeconds: number | null;

  constructor(retryAfterSeconds: number | null) {
    super("Microsoft Graph rate limit exceeded.");
    this.name = "GraphRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GraphApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "GraphApiError";
    this.status = status;
    this.code = code;
  }
}

/** Maps a failed Graph HTTP response onto a typed error. Never includes tokens. */
export function normalizeGraphError(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): Error {
  const parsed = (body ?? {}) as GraphErrorBody;
  const code = parsed.error?.code;
  const message =
    parsed.error?.message ??
    `Microsoft Graph request failed with status ${status}.`;

  if (status === 401) return new GraphAuthError(message);
  if (status === 429) {
    const retryAfter = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10)
      : null;
    return new GraphRateLimitError(
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return new GraphApiError(status, code, message);
}
