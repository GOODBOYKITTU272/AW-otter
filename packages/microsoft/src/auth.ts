import { randomBytes, timingSafeEqual } from "node:crypto";
import { buildAuthority, scopeString } from "./config";
import { normalizeGraphError } from "./errors";
import type { GraphTokenResponse, MicrosoftIdentity } from "./types";

export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison — OAuth state doubles as CSRF protection. */
export function validateState(
  received: string | null,
  expected: string | null,
): boolean {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface BuildAuthorizationUrlInput {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
}

export function buildAuthorizationUrl(
  input: BuildAuthorizationUrlInput,
): string {
  const url = new URL(
    `${buildAuthority(input.tenantId)}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", scopeString());
  url.searchParams.set("state", input.state);
  return url.toString();
}

interface RawTokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

async function parseTokenResponse(
  response: Response,
): Promise<GraphTokenResponse> {
  const body = (await response
    .json()
    .catch(() => ({}))) as RawTokenResponseBody;
  if (!response.ok) {
    throw normalizeGraphError(
      response.status,
      body,
      response.headers.get("retry-after"),
    );
  }
  if (!body.access_token) {
    throw new Error(
      "Microsoft token response did not include an access_token.",
    );
  }
  const expiresInSeconds =
    typeof body.expires_in === "number" ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    idToken: body.id_token ?? null,
  };
}

export interface ExchangeCodeInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}

export async function exchangeCodeForTokens(
  input: ExchangeCodeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphTokenResponse> {
  const response = await fetchImpl(
    `${buildAuthority(input.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        scope: scopeString(),
      }),
    },
  );
  return parseTokenResponse(response);
}

export interface RefreshTokenInput {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export async function refreshAccessToken(
  input: RefreshTokenInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphTokenResponse> {
  const response = await fetchImpl(
    `${buildAuthority(input.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
        scope: scopeString(),
      }),
    },
  );
  return parseTokenResponse(response);
}

interface IdTokenPayload {
  oid?: string;
  sub?: string;
  preferred_username?: string;
  email?: string;
  name?: string;
}

/** Identity claims come from the ID token — no separate Graph call or `User.Read` needed. */
export function decodeIdentityFromIdToken(idToken: string): MicrosoftIdentity {
  const parts = idToken.split(".");
  const payloadSegment = parts[1];
  if (parts.length !== 3 || !payloadSegment)
    throw new Error("Malformed Microsoft ID token.");
  const payload: IdTokenPayload = JSON.parse(
    Buffer.from(payloadSegment, "base64url").toString("utf8"),
  );
  const providerUserId = payload.oid ?? payload.sub;
  if (!providerUserId)
    throw new Error("Microsoft ID token is missing an identity claim.");
  return {
    providerUserId,
    email: payload.email ?? payload.preferred_username ?? null,
    displayName: payload.name ?? null,
  };
}
