import { describe, expect, it } from "vitest";
import {
  TranscriptionApiError,
  TranscriptionAuthError,
  TranscriptionEmptyTranscriptError,
  TranscriptionMalformedResponseError,
  TranscriptionRateLimitError,
  TranscriptionTimeoutError,
  classifyProviderFailure,
  isRetryableProviderFailure,
  validateTranscriptionResult,
} from "./errors";

describe("Provider Failure Taxonomy and Classification", () => {
  it("classifies typed errors correctly", () => {
    expect(classifyProviderFailure(new TranscriptionAuthError())).toBe("AUTH_FAILURE");
    expect(classifyProviderFailure(new TranscriptionRateLimitError())).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(new TranscriptionTimeoutError())).toBe("TIMEOUT");
    expect(classifyProviderFailure(new TranscriptionMalformedResponseError("bad"))).toBe("INVALID_RESPONSE");
    expect(classifyProviderFailure(new TranscriptionEmptyTranscriptError())).toBe("EMPTY_TRANSCRIPT");
  });

  it("classifies HTTP status codes on TranscriptionApiError", () => {
    expect(classifyProviderFailure(new TranscriptionApiError(401, "unauthorized"))).toBe("AUTH_FAILURE");
    expect(classifyProviderFailure(new TranscriptionApiError(403, "forbidden"))).toBe("AUTH_FAILURE");
    expect(classifyProviderFailure(new TranscriptionApiError(429, "rate limit"))).toBe("RATE_LIMIT");
    expect(classifyProviderFailure(new TranscriptionApiError(500, "internal error"))).toBe("PROVIDER_5XX");
    expect(classifyProviderFailure(new TranscriptionApiError(502, "bad gateway"))).toBe("PROVIDER_5XX");
    expect(classifyProviderFailure(new TranscriptionApiError(503, "unavailable"))).toBe("PROVIDER_5XX");
    expect(classifyProviderFailure(new TranscriptionApiError(504, "gateway timeout"))).toBe("PROVIDER_5XX");
    expect(classifyProviderFailure(new TranscriptionApiError(415, "unsupported media"))).toBe("UNSUPPORTED_AUDIO");
    expect(classifyProviderFailure(new TranscriptionApiError(400, "bad request"))).toBe("INVALID_RESPONSE");
    expect(classifyProviderFailure(new TranscriptionApiError(422, "unprocessable"))).toBe("INVALID_RESPONSE");
    expect(classifyProviderFailure(new TranscriptionApiError(404, "not found"))).toBe("NON_RETRYABLE_PROVIDER_ERROR");
  });

  it("classifies network and timeout errors via typed names and error codes", () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    expect(classifyProviderFailure(abortErr)).toBe("TIMEOUT");

    const timeoutErr = new Error("timeout");
    timeoutErr.name = "TimeoutError";
    expect(classifyProviderFailure(timeoutErr)).toBe("TIMEOUT");

    const connRefused = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(classifyProviderFailure(connRefused)).toBe("PROVIDER_UNAVAILABLE");

    const fetchErrWithCause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect reset"), { code: "ECONNRESET" }),
    });
    expect(classifyProviderFailure(fetchErrWithCause)).toBe("PROVIDER_UNAVAILABLE");

    const timeoutCause = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" }),
    });
    expect(classifyProviderFailure(timeoutCause)).toBe("TIMEOUT");
  });

  it("determines retryability according to policy", () => {
    expect(isRetryableProviderFailure("TIMEOUT")).toBe(true);
    expect(isRetryableProviderFailure("RATE_LIMIT")).toBe(true);
    expect(isRetryableProviderFailure("PROVIDER_5XX")).toBe(true);
    expect(isRetryableProviderFailure("PROVIDER_UNAVAILABLE")).toBe(true);

    expect(isRetryableProviderFailure("AUTH_FAILURE")).toBe(false);
    expect(isRetryableProviderFailure("INVALID_RESPONSE")).toBe(false);
    expect(isRetryableProviderFailure("EMPTY_TRANSCRIPT")).toBe(false);
    expect(isRetryableProviderFailure("UNSUPPORTED_AUDIO")).toBe(false);
    expect(isRetryableProviderFailure("NON_RETRYABLE_PROVIDER_ERROR")).toBe(false);
  });

  it("validates transcription results with empty transcript guard", () => {
    expect(() => validateTranscriptionResult({ text: "", segments: [] })).toThrow(
      TranscriptionEmptyTranscriptError,
    );
    expect(() => validateTranscriptionResult({ text: "   ", segments: [{ index: 0 }] })).toThrow(
      TranscriptionEmptyTranscriptError,
    );
    expect(() => validateTranscriptionResult({ text: "Hello", segments: [] })).toThrow(
      TranscriptionEmptyTranscriptError,
    );
    expect(() =>
      validateTranscriptionResult({
        text: "Hello world",
        segments: [{ index: 0, text: "Hello world" }],
      }),
    ).not.toThrow();
  });
});
