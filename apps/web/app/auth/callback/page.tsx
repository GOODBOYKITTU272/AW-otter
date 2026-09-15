"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";
import { urlLooksLikeAuthCallback } from "../set-password/auth-callback";

export const dynamic = "force-dynamic";

/**
 * Supabase Auth callback page.
 * Handles BOTH magic link flows:
 * 1. PKCE: ?code=<uuid> → exchangeCodeForSession → getSession
 * 2. Implicit: #access_token=...&refresh_token=... → setSession → getSession
 *
 * Always succeeds if getSession() returns a valid session, without requiring
 * the onAuthStateChange event to fire (which can be missed in implicit flows).
 * Server-rendered root page cannot see hash fragments, so this dedicated
 * client page is required to complete the auth handshake for magic links.
 */
export default function AuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function handleCallback() {
      const supabase = getSupabaseBrowserClient();

      const errorParam = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");
      const hashErrorMatch = window.location.hash.match(/[#&]error=([^&]+)/);
      const hashErrorDescMatch = window.location.hash.match(/[#&]error_description=([^&]+)/);

      if (errorParam || hashErrorMatch) {
        const errorMsg = errorDescription || 
          (hashErrorDescMatch?.[1] ? decodeURIComponent(hashErrorDescMatch[1]) : "Authentication failed");
        setError(errorMsg);
        setTimeout(() => router.replace("/login"), 3000);
        return;
      }

      try {
        const code = searchParams.get("code");
        const hash = window.location.hash.substring(1);
        const hashParams = new URLSearchParams(hash);
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        if (code) {
          const { error: exchangeError } =
            await supabase.auth.exchangeCodeForSession(code);

          if (exchangeError) {
            console.error("Failed to exchange code for session:", exchangeError);
            setError("Invalid or expired code. Please try again.");
            setTimeout(() => router.replace("/login"), 3000);
            return;
          }
        } else if (accessToken && refreshToken) {
          const { error: setSessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });

          if (setSessionError) {
            console.error("Failed to set session from hash:", setSessionError);
            setError("Invalid or expired token. Please try again.");
            setTimeout(() => router.replace("/login"), 3000);
            return;
          }
        } else if (!urlLooksLikeAuthCallback(window.location.href)) {
          setError("No authentication code or token found");
          setTimeout(() => router.replace("/login"), 3000);
          return;
        }

        let {
          data: { session },
        } = await supabase.auth.getSession();

        if (!session) {
          // Short fallback retry for background session detection
          await new Promise((resolve) => setTimeout(resolve, 500));
          const retry = await supabase.auth.getSession();
          session = retry.data.session;
        }

        if (!session) {
          setError("Session could not be established. Please try again.");
          setTimeout(() => router.replace("/login"), 3000);
          return;
        }

        const { data: membership } = await supabase
          .from("organization_memberships")
          .select("role_id, status")
          .eq("user_id", session.user.id)
          .eq("status", "active")
          .maybeSingle();

        if (!membership) {
          window.location.assign("/access-pending");
          return;
        }

        const { data: role } = await supabase
          .from("roles")
          .select("key")
          .eq("id", membership.role_id)
          .maybeSingle();

        const roleKey = role?.key;

        if (!roleKey || !isSystemRoleKey(roleKey)) {
          window.location.assign("/access-pending");
          return;
        }

        const cleanUrl = new URL(window.location.href);
        cleanUrl.search = "";
        cleanUrl.hash = "";
        window.history.replaceState({}, "", cleanUrl.toString());

        window.location.assign(ROLE_HOME_ROUTE[roleKey]);
      } catch (err) {
        console.error("Auth callback error:", err);
        setError("An unexpected error occurred. Please try again.");
        setTimeout(() => router.replace("/login"), 3000);
      }
    }

    handleCallback();
  }, [router, searchParams]);

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] to-[#1E1E1E] px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1E1E1E]/90 backdrop-blur-xl p-8 shadow-2xl text-center">
        {error ? (
          <>
            <div className="mb-6">
              <svg
                className="mx-auto h-12 w-12 text-[#FF5C5C]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">
              Authentication Failed
            </h1>
            <p className="text-sm text-[#FF5C5C] mb-4">{error}</p>
            <p className="text-xs text-[#F5F5F5]/60">
              Redirecting to login page...
            </p>
          </>
        ) : (
          <>
            <div className="mb-6">
              <svg
                className="animate-spin mx-auto h-12 w-12 text-[#29FE29]"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-white mb-2">
              Completing sign in...
            </h1>
            <p className="text-sm text-[#F5F5F5]/70">
              Please wait while we verify your authentication.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
