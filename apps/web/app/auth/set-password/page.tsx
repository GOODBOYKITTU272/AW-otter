"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  isGenuineAuthCallbackEvent,
  urlLooksLikeAuthCallback,
} from "./auth-callback";

/**
 * M17B: consumes a Supabase invite (or password-recovery) link and lets the
 * user set their initial password. This is the page that was missing —
 * bootstrap-admin.mjs's production path already calls
 * supabase.auth.admin.inviteUserByEmail, which sends a real email, but
 * nothing in the app handled the resulting link (M17A finding).
 *
 * SECURITY (fixed after adversarial review — see auth-callback.ts for the
 * full trace against the actual SDK source): this page must NEVER grant
 * access merely because `getSession()` returns something truthy — an
 * ordinary already-logged-in user's own persisted session would satisfy
 * that just as well as a genuine invite link, letting anyone with
 * temporary access to an authenticated browser silently change the
 * password and lock the real owner out. Access requires BOTH: the URL
 * itself must carry the exact shape Supabase's client only ever produces
 * for a real auth-callback link (`urlLooksLikeAuthCallback`), AND the SDK
 * must have actually fired a SIGNED_IN/PASSWORD_RECOVERY event as a
 * direct result of processing THIS page's own URL
 * (`isGenuineAuthCallbackEvent`) — never the ambient/ambient-independent
 * `getSession()` return value.
 *
 * No self-signup path exists anywhere that leads here — this page is only
 * ever reachable via a link Supabase itself emailed to an already-invited
 * address, and `updateUser({password})` can only ever modify the
 * CURRENTLY authenticated session's own user — it cannot create or take
 * over an arbitrary account.
 */
export default function SetPasswordPage() {
  const router = useRouter();
  // Computed once, synchronously, at first render (never inside an
  // effect) — this is what lets `checking` start out already-false for
  // the "ordinary session, no callback params at all" case with no
  // synchronous setState call needed inside the effect below (React's
  // own react-hooks/set-state-in-effect rule flags that pattern).
  // window is undefined during Next.js's server render of this "use
  // client" page; there are never real callback params to find then
  // either, so `false` is the correct SSR-time answer regardless.
  const [urlIsAuthCallback] = useState(() =>
    typeof window !== "undefined"
      ? urlLooksLikeAuthCallback(window.location.href)
      : false,
  );
  const [checking, setChecking] = useState(urlIsAuthCallback);
  const [hasSession, setHasSession] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!urlIsAuthCallback) {
      // No auth-callback shape in this URL at all — an ordinary
      // navigation (bookmark, direct visit, an already-authenticated
      // user's own tab). `checking` already started as `false` (see the
      // useState initializer above), so there's nothing to do here — an
      // ambient existing session must never grant access.
      return;
    }

    const supabase = getSupabaseBrowserClient();
    let resolved = false;

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (event, session) => {
        if (isGenuineAuthCallbackEvent(event) && session) {
          resolved = true;
          setHasSession(true);
          setChecking(false);
        }
      },
    );

    // The SDK resolves a genuine URL-token exchange via a deferred
    // setTimeout(0) internally — this is a bounded safety net against a
    // hung network request during that exchange, not the primary signal.
    const timeout = setTimeout(() => {
      if (!resolved) setChecking(false);
    }, 5000);

    return () => {
      subscription.subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [urlIsAuthCallback]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await getSupabaseBrowserClient().auth.updateUser({
      password,
    });
    setSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    setDone(true);
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 1500);
  }

  if (checking) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Checking your invite link…
        </p>
      </main>
    );
  }

  if (!hasSession) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Invite link invalid or expired
        </h1>
        <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
          This link didn&apos;t establish a valid session. Ask your admin to send
          a new invite, or{" "}
          <a href="/login" className="underline">
            sign in
          </a>{" "}
          if you already have a password.
        </p>
      </main>
    );
  }

  if (done) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Password set
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Taking you to Signal…
        </p>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Set your password
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Choose a password for your ApplyWizz Signal account.
        </p>
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Confirm password
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {submitting ? "Setting password…" : "Set password"}
        </button>
      </form>
    </main>
  );
}
