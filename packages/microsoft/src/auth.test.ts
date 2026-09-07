import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  decodeIdentityFromIdToken,
  exchangeCodeForTokens,
  generateState,
  getAppOnlyAccessToken,
  refreshAccessToken,
  validateState,
} from "./auth";
import { GraphAuthError } from "./errors";

function makeIdToken(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${base64url({ alg: "none" })}.${base64url(payload)}.signature`;
}

function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

describe("generateState / validateState", () => {
  it("generates a non-empty, sufficiently random-looking string", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("validates a matching state", () => {
    const state = generateState();
    expect(validateState(state, state)).toBe(true);
  });

  it("rejects a mismatched state", () => {
    expect(validateState(generateState(), generateState())).toBe(false);
  });

  it("rejects when either side is missing", () => {
    expect(validateState(null, "x")).toBe(false);
    expect(validateState("x", null)).toBe(false);
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a tenant-specific authorization URL with the expected params", () => {
    const url = new URL(
      buildAuthorizationUrl({
        tenantId: "tenant-123",
        clientId: "client-abc",
        redirectUri: "https://app.example.com/callback",
        state: "state-xyz",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-abc");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/callback",
    );
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toContain("Calendars.Read");
    expect(url.searchParams.get("scope")).not.toContain("Mail.Read");
  });
});

describe("exchangeCodeForTokens / refreshAccessToken", () => {
  const input = {
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    redirectUri: "https://app.example.com/callback",
    code: "auth-code",
  };

  it("parses a successful token response", async () => {
    const tokens = await exchangeCodeForTokens(
      input,
      fakeFetch(200, {
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        id_token: "idt",
      }),
    );
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.idToken).toBe("idt");
    expect(new Date(tokens.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("normalizes a failed exchange into a typed Graph error", async () => {
    await expect(
      exchangeCodeForTokens(
        input,
        fakeFetch(401, {
          error: { code: "invalid_grant", message: "bad code" },
        }),
      ),
    ).rejects.toBeInstanceOf(GraphAuthError);
  });

  it("refreshes using a refresh token", async () => {
    const tokens = await refreshAccessToken(
      { tenantId: "t", clientId: "c", clientSecret: "s", refreshToken: "rt" },
      fakeFetch(200, { access_token: "new-at", expires_in: 3600 }),
    );
    expect(tokens.accessToken).toBe("new-at");
  });
});

describe("getAppOnlyAccessToken", () => {
  const input = { tenantId: "t", clientId: "c", clientSecret: "s" };

  it("parses a successful client_credentials response", async () => {
    const token = await getAppOnlyAccessToken(
      input,
      fakeFetch(200, { access_token: "app-only-at", expires_in: 3600 }),
    );
    expect(token.accessToken).toBe("app-only-at");
    expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("normalizes a failed acquisition into a typed Graph error", async () => {
    await expect(
      getAppOnlyAccessToken(
        input,
        fakeFetch(401, { error: "invalid_client", error_description: "bad secret" }),
      ),
    ).rejects.toBeInstanceOf(GraphAuthError);
  });

  it("throws when the response is missing an access_token", async () => {
    await expect(
      getAppOnlyAccessToken(input, fakeFetch(200, { expires_in: 3600 })),
    ).rejects.toThrow(/access_token/);
  });
});

describe("decodeIdentityFromIdToken", () => {
  it("extracts oid/email/name claims", () => {
    const token = makeIdToken({
      oid: "user-oid-1",
      email: "person@applywizz.com",
      name: "Person",
    });
    expect(decodeIdentityFromIdToken(token)).toEqual({
      providerUserId: "user-oid-1",
      email: "person@applywizz.com",
      displayName: "Person",
    });
  });

  it("falls back to preferred_username when email is absent", () => {
    const token = makeIdToken({
      oid: "user-oid-2",
      preferred_username: "person2@applywizz.com",
    });
    expect(decodeIdentityFromIdToken(token).email).toBe(
      "person2@applywizz.com",
    );
  });

  it("throws on a malformed token", () => {
    expect(() => decodeIdentityFromIdToken("not-a-jwt")).toThrow(/Malformed/);
  });

  it("throws when no identity claim is present", () => {
    const token = makeIdToken({ name: "No Id" });
    expect(() => decodeIdentityFromIdToken(token)).toThrow(/identity claim/);
  });
});
