import { describe, expect, it } from "vitest";
import {
  GraphApiError,
  GraphAuthError,
  GraphRateLimitError,
  normalizeGraphError,
} from "./errors";

describe("normalizeGraphError", () => {
  it("maps 401 to GraphAuthError", () => {
    expect(
      normalizeGraphError(401, { error: { message: "bad token" } }),
    ).toBeInstanceOf(GraphAuthError);
  });

  it("maps 429 to GraphRateLimitError and parses Retry-After", () => {
    const error = normalizeGraphError(429, {}, "30");
    expect(error).toBeInstanceOf(GraphRateLimitError);
    expect((error as GraphRateLimitError).retryAfterSeconds).toBe(30);
  });

  it("defaults retryAfterSeconds to null when the header is absent", () => {
    const error = normalizeGraphError(429, {}, null);
    expect((error as GraphRateLimitError).retryAfterSeconds).toBeNull();
  });

  it("maps other statuses to GraphApiError with the Graph error code preserved", () => {
    const error = normalizeGraphError(500, {
      error: { code: "ServiceError", message: "boom" },
    });
    expect(error).toBeInstanceOf(GraphApiError);
    expect((error as GraphApiError).status).toBe(500);
    expect((error as GraphApiError).code).toBe("ServiceError");
    expect(error.message).toBe("boom");
  });

  it("falls back to a generic message when the body has no error field", () => {
    const error = normalizeGraphError(503, {});
    expect(error.message).toContain("503");
  });
});
