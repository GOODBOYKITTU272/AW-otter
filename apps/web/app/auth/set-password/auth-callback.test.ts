import { describe, expect, it } from "vitest";
import {
  isGenuineAuthCallbackEvent,
  urlLooksLikeAuthCallback,
} from "./auth-callback";

const BASE = "https://signal.applywizz.test/auth/set-password";

describe("urlLooksLikeAuthCallback", () => {
  it("recognizes a PKCE-flow code param (the shape an invite/recovery link produces)", () => {
    expect(urlLooksLikeAuthCallback(`${BASE}?code=abc123`)).toBe(true);
  });

  it("recognizes an implicit-flow access_token in the hash", () => {
    expect(
      urlLooksLikeAuthCallback(`${BASE}#access_token=xyz&type=invite`),
    ).toBe(true);
  });

  it("recognizes an error redirect (expired/invalid link) as still callback-shaped", () => {
    expect(
      urlLooksLikeAuthCallback(
        `${BASE}#error=access_denied&error_description=Email+link+is+invalid+or+has+expired`,
      ),
    ).toBe(true);
  });

  it("rejects a plain direct visit with no auth params at all — the ordinary-authenticated-session case", () => {
    expect(urlLooksLikeAuthCallback(BASE)).toBe(false);
  });

  it("rejects an irrelevant query param that isn't one of the real callback markers", () => {
    expect(urlLooksLikeAuthCallback(`${BASE}?foo=bar`)).toBe(false);
  });
});

describe("isGenuineAuthCallbackEvent", () => {
  it("accepts SIGNED_IN — the actual event Supabase fires for a consumed invite link (verified against auth-js source: there is no distinct INVITE event)", () => {
    expect(isGenuineAuthCallbackEvent("SIGNED_IN")).toBe(true);
  });

  it("accepts PASSWORD_RECOVERY — the event for a consumed recovery-type link", () => {
    expect(isGenuineAuthCallbackEvent("PASSWORD_RECOVERY")).toBe(true);
  });

  it("rejects every other AuthChangeEvent", () => {
    expect(isGenuineAuthCallbackEvent("INITIAL_SESSION")).toBe(false);
    expect(isGenuineAuthCallbackEvent("TOKEN_REFRESHED")).toBe(false);
    expect(isGenuineAuthCallbackEvent("SIGNED_OUT")).toBe(false);
    expect(isGenuineAuthCallbackEvent("USER_UPDATED")).toBe(false);
  });
});

describe("combined gate — the four required regression scenarios", () => {
  // The page only shows the set-password form when BOTH functions agree;
  // these tests exercise that combination directly, mapped to exactly the
  // four scenarios required after the adversarial review.

  function pageWouldAuthorize(href: string, firedEvent: string | null): boolean {
    if (!urlLooksLikeAuthCallback(href)) return false;
    if (firedEvent === null) return false;
    return isGenuineAuthCallbackEvent(firedEvent);
  }

  it("1. a genuine invited user (real code param, SDK fires SIGNED_IN) is authorized", () => {
    expect(pageWouldAuthorize(`${BASE}?code=real-pkce-code`, "SIGNED_IN")).toBe(
      true,
    );
  });

  it("2. an ordinary authenticated session (no callback params in the URL at all, regardless of what event may or may not fire) is NOT authorized", () => {
    // No URL params -> rejected before the event even matters. This is
    // the exact scenario the original bug allowed: an already-logged-in
    // user just navigating here, where the SDK's storage-recovery path
    // also fires SIGNED_IN (verified against auth-js source) — the URL
    // gate is what makes this fail now.
    expect(pageWouldAuthorize(BASE, "SIGNED_IN")).toBe(false);
  });

  it("3. invalid/expired flow fails closed (URL looks callback-shaped, e.g. a forged/garbage code, but no genuine event ever fires)", () => {
    expect(pageWouldAuthorize(`${BASE}?code=forged-or-expired`, null)).toBe(
      false,
    );
  });

  it("3b. an expired-link error redirect also fails closed", () => {
    expect(
      pageWouldAuthorize(`${BASE}#error=access_denied&error_code=otp_expired`, null),
    ).toBe(false);
  });

  // 4. Public signup remains impossible. Not expressible as a unit test
  // here — there is no live Supabase integration test anywhere in this
  // codebase to assert against, and a fake always-true assertion would be
  // dishonest. Verified instead by direct inspection, recorded as a real
  // claim, not silently assumed: page.tsx calls exactly one Supabase
  // Auth method, `auth.updateUser({ password })`, which per the SDK's own
  // contract only ever modifies the CURRENTLY authenticated session's own
  // user — it has no signUp/createUser/admin capability and cannot
  // create or take over an arbitrary account. Neither this file nor
  // page.tsx imports or calls anything else from the auth namespace.
});
