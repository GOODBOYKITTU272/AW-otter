import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

function fakeRequest(headers: Record<string, string>): NextRequest {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

describe("isAuthorizedInternalRequest", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.INTERNAL_QUEUE_SECRET = "internal-secret";
    process.env.CRON_SECRET = "cron-secret";
  });
  afterEach(() => {
    delete process.env.INTERNAL_QUEUE_SECRET;
    delete process.env.CRON_SECRET;
  });

  it("authorizes the existing x-internal-queue-secret header (manual/on-demand callers, unchanged)", async () => {
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ "x-internal-queue-secret": "internal-secret" });
    expect(isAuthorizedInternalRequest(request)).toBe(true);
  });

  it("rejects a wrong x-internal-queue-secret with no Authorization header", async () => {
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ "x-internal-queue-secret": "wrong" });
    expect(isAuthorizedInternalRequest(request)).toBe(false);
  });

  it("authorizes a correct Authorization: Bearer <CRON_SECRET> header (cron trigger shape)", async () => {
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ authorization: "Bearer cron-secret" });
    expect(isAuthorizedInternalRequest(request)).toBe(true);
  });

  it("rejects a wrong bearer token", async () => {
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ authorization: "Bearer wrong" });
    expect(isAuthorizedInternalRequest(request)).toBe(false);
  });

  it("rejects a request with neither header", async () => {
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({});
    expect(isAuthorizedInternalRequest(request)).toBe(false);
  });

  it("fails closed (never treats an unconfigured CRON_SECRET as always-authorized) when a Bearer token is presented but CRON_SECRET isn't set", async () => {
    delete process.env.CRON_SECRET;
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ authorization: "Bearer anything" });
    expect(isAuthorizedInternalRequest(request)).toBe(false);
  });

  it("an unconfigured CRON_SECRET does not break the existing internal-secret path", async () => {
    delete process.env.CRON_SECRET;
    const { isAuthorizedInternalRequest } = await import("./internal-route-auth");
    const request = fakeRequest({ "x-internal-queue-secret": "internal-secret" });
    expect(isAuthorizedInternalRequest(request)).toBe(true);
  });
});
