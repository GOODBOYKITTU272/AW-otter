/**
 * M17B BLOCKING fix. Verified against the actual installed SDK source
 * (@supabase/auth-js@2.115.0's GoTrueClient.js) before writing this, not
 * assumed:
 *
 * - There is NO distinct "invite" AuthChangeEvent. GoTrueClient's own URL
 *   handler only fires `PASSWORD_RECOVERY` when the link's `redirectType`
 *   is literally `'recovery'`; every other type — including `invite` —
 *   falls through to `SIGNED_IN` (GoTrueClient.js:416-420, :1642).
 * - `SIGNED_IN` ALSO fires when the client loads an ordinary,
 *   already-persisted session from storage at page load, completely
 *   independent of any URL token (GoTrueClient.js:4145). The event name
 *   alone can never distinguish "just consumed a real invite link" from
 *   "already logged in, navigated here directly" — this is the exact bug
 *   the original version of this page had (it used the presence of ANY
 *   session as authorization).
 * - A URL carrying a garbage/forged `code=`/`access_token=` value does
 *   NOT clear or touch a pre-existing valid session on failure
 *   (GoTrueClient.js:405-407, explicit comment: "Don't remove existing
 *   session on URL login failure... shouldn't invalidate a valid
 *   session") — and critically, that failure path returns early without
 *   ever notifying subscribers via SIGNED_IN/PASSWORD_RECOVERY for this
 *   attempt. So checking the URL shape ALONE is not sufficient either: an
 *   attacker who sends an already-logged-in victim a link like
 *   `/auth/set-password?code=garbage` would pass a URL-shape check, and
 *   if this page then trusted `getSession()`'s ambient return value, it
 *   would grant access using the victim's own unrelated pre-existing
 *   session. That is why this page must require BOTH signals together:
 *   the URL must look like a genuine callback (this file's
 *   `urlLooksLikeAuthCallback`), AND the SDK must have actually fired a
 *   SIGNED_IN/PASSWORD_RECOVERY event as a direct result of processing it
 *   (`isGenuineAuthCallbackEvent`) — never `getSession()`'s bare return
 *   value on its own.
 */

/**
 * True only if the given URL carries the exact shape @supabase/auth-js's
 * own client checks for before it will even attempt to process a URL as
 * an auth callback (`_isImplicitGrantCallback`/`_isPKCECallback` in
 * GoTrueClient.js) — an implicit-flow hash fragment with `access_token`
 * (or an `error`/`error_description`/`error_code` for an expired/invalid
 * link), or a PKCE-flow `code` query parameter. A plain direct visit
 * (bookmark, typed URL, an already-authenticated user just navigating
 * here) has none of these.
 */
export function urlLooksLikeAuthCallback(href: string): boolean {
  const url = new URL(href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const queryParams = url.searchParams;
  return (
    hashParams.has("access_token") ||
    hashParams.has("error") ||
    hashParams.has("error_description") ||
    hashParams.has("error_code") ||
    queryParams.has("code") ||
    queryParams.has("error")
  );
}

/**
 * The only two AuthChangeEvent values that genuinely mean "a session was
 * just established by the SDK processing this page's own URL" —
 * meaningful ONLY in combination with `urlLooksLikeAuthCallback` above,
 * never on its own (see this file's header comment for why).
 */
export function isGenuineAuthCallbackEvent(event: string): boolean {
  return event === "SIGNED_IN" || event === "PASSWORD_RECOVERY";
}
