import { describe, expect, it } from "vitest";
import {
  urlLooksLikeAuthCallback,
  isGenuineAuthCallbackEvent,
} from "../set-password/auth-callback";

const CALLBACK_BASE = "https://echo.applywizz.ai/auth/callback";

describe("Auth callback URL detection", () => {
  it("recognizes PKCE flow with code query param", () => {
    expect(urlLooksLikeAuthCallback(`${CALLBACK_BASE}?code=abc123`)).toBe(true);
  });

  it("recognizes implicit flow with access_token in hash", () => {
    expect(
      urlLooksLikeAuthCallback(
        `${CALLBACK_BASE}#access_token=xyz&refresh_token=abc&type=magiclink`,
      ),
    ).toBe(true);
  });

  it("recognizes error redirects from expired/invalid links", () => {
    expect(
      urlLooksLikeAuthCallback(
        `${CALLBACK_BASE}?error=access_denied&error_description=Invalid+code`,
      ),
    ).toBe(true);
    expect(
      urlLooksLikeAuthCallback(
        `${CALLBACK_BASE}#error=access_denied&error_code=otp_expired`,
      ),
    ).toBe(true);
  });

  it("rejects plain navigation without auth params", () => {
    expect(urlLooksLikeAuthCallback(CALLBACK_BASE)).toBe(false);
  });
});

describe("Auth callback event validation", () => {
  it("accepts SIGNED_IN event from successful auth", () => {
    expect(isGenuineAuthCallbackEvent("SIGNED_IN")).toBe(true);
  });

  it("accepts PASSWORD_RECOVERY event", () => {
    expect(isGenuineAuthCallbackEvent("PASSWORD_RECOVERY")).toBe(true);
  });

  it("rejects other auth events", () => {
    expect(isGenuineAuthCallbackEvent("INITIAL_SESSION")).toBe(false);
    expect(isGenuineAuthCallbackEvent("TOKEN_REFRESHED")).toBe(false);
    expect(isGenuineAuthCallbackEvent("SIGNED_OUT")).toBe(false);
    expect(isGenuineAuthCallbackEvent("USER_UPDATED")).toBe(false);
  });
});
