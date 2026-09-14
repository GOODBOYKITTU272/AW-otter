"use client";

import { useState, useEffect, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Eye, EyeOff } from "lucide-react";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";
import Link from "next/link";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleResetPassword() {
    if (!email.trim()) {
      setError("Please enter your email above first to receive your login setup link.");
      return;
    }
    setResetting(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const supabase = getSupabaseBrowserClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/auth/set-password`,
      });
      if (resetError) {
        setError(resetError.message);
      } else {
        setSuccessMessage(`Password setup link sent to ${email}! Check your inbox.`);
      }
    } catch {
      setError("Failed to send reset link. Please try again.");
    } finally {
      setResetting(false);
    }
  }

  useEffect(() => {
    async function checkExistingSession() {
      const supabase = getSupabaseBrowserClient();
      const { data: { session } } = await supabase.auth.getSession();
      
      if (session) {
        const { data: membership } = await supabase
          .from("organization_memberships")
          .select("role_id")
          .eq("user_id", session.user.id)
          .eq("status", "active")
          .maybeSingle();

        if (membership) {
          const { data: role } = await supabase
            .from("roles")
            .select("key")
            .eq("id", membership.role_id)
            .maybeSingle();

          const roleKey = role?.key;
          if (roleKey && isSystemRoleKey(roleKey)) {
            window.location.assign(ROLE_HOME_ROUTE[roleKey]);
          }
        }
      }
    }
    checkExistingSession();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const supabase = getSupabaseBrowserClient();
    const { error: signInError, data } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError("Invalid email or password. Please try again.");
      setSubmitting(false);
      return;
    }

    const { data: membership } = await supabase
      .from("organization_memberships")
      .select("role_id")
      .eq("user_id", data.user.id)
      .eq("status", "active")
      .maybeSingle();

    if (!membership) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Hard navigation required to commit cookies before SSR
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
      setError(
        "Your account role is not recognized. Please contact your administrator."
      );
      setSubmitting(false);
      return;
    }

    window.location.assign(ROLE_HOME_ROUTE[roleKey]);
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] to-[#1E1E1E] px-4 sm:px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6 sm:mb-8">
          <Link href="/" className="inline-flex items-center gap-3 mb-4 sm:mb-6 hover:opacity-80 transition-opacity">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center shadow-lg">
              <span className="text-xl font-bold text-white">AW</span>
            </div>
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
            Sign in to Echo
          </h1>
          <p className="text-sm text-[#F5F5F5]/70">
            Enter your email and authenticator code to continue.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/90 backdrop-blur-xl p-6 sm:p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            {/* Email field */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-white flex items-center gap-2">
                <svg className="h-4 w-4 text-[#2C76FF]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Email
              </label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-xl border border-white/10 bg-[#0B1D33]/80 px-4 py-3.5 text-sm text-white placeholder-[#F5F5F5]/40 focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/30 transition-all min-h-[48px]"
                placeholder="you@example.com"
              />
            </div>

            {/* Authenticator code field (styled like TOTP but uses password for now) */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-semibold text-white flex items-center gap-2">
                <svg className="h-4 w-4 text-[#29FE29]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                Authenticator code (AW Echo)
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-xl border border-white/10 bg-[#0B1D33]/80 px-4 py-3.5 pr-12 text-sm text-white placeholder-[#F5F5F5]/40 focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/30 transition-all min-h-[48px]"
                  placeholder="Enter 6-digit code or password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-[#F5F5F5]/50 hover:text-white transition-colors min-h-[44px] w-[44px] flex items-center justify-center"
                  aria-label={showPassword ? "Hide code" : "Show code"}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setShowHelp(!showHelp)}
                className="text-xs text-[#2C76FF] hover:underline self-start mt-1 min-h-[44px] flex items-center"
              >
                ? Need help with authenticator code
              </button>
              {showHelp && (
                <div className="rounded-xl border border-white/10 bg-[#0B1D33]/90 p-4 text-xs text-[#F5F5F5]/80 space-y-2">
                  <p className="font-semibold text-white">How login works:</p>
                  <p>
                    Echo accounts use a 6-character access code (password) set during your initial invite.
                  </p>
                  <p>
                    If you haven&apos;t configured your code yet or need to reset it,{" "}
                    <button
                      type="button"
                      onClick={handleResetPassword}
                      disabled={resetting}
                      className="text-[#29FE29] font-bold underline hover:opacity-80 disabled:opacity-50"
                    >
                      {resetting ? "Sending reset link…" : "click here to email a reset link"}
                    </button>
                    .
                  </p>
                </div>
              )}
            </div>

            {successMessage ? (
              <div
                role="status"
                className="rounded-xl border border-[#29FE29]/30 bg-[#29FE29]/10 px-4 py-3.5 text-sm text-[#29FE29] flex items-center gap-3"
              >
                <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {successMessage}
              </div>
            ) : null}

            {error ? (
              <div
                role="alert"
                className="rounded-xl border border-[#FF5C5C]/30 bg-[#FF5C5C]/10 px-4 py-3.5 text-sm text-[#FF5C5C] flex items-center gap-3"
              >
                <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded-xl bg-[#29FE29] px-6 py-4 text-base font-bold text-[#1E1E1E] hover:bg-[#29FE29]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-[#29FE29]/20 flex items-center justify-center gap-2 min-h-[56px]"
            >
              {submitting ? (
                <>
                  <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </>
              )}
            </button>
          </form>

          <div className="mt-6 space-y-3">
            <div className="flex items-start gap-2 text-xs text-[#2C76FF] bg-[#2C76FF]/10 rounded-lg px-4 py-3">
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                Invite-only. Use the code from your authenticator app named <strong>AW Echo</strong>.
              </span>
            </div>
            
            <div className="flex items-start gap-2 text-xs text-[#F5F5F5]/60 rounded-lg px-4 py-3 border border-white/10">
              <svg className="h-4 w-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>
                First-time setup or forgot code?{" "}
                <button
                  type="button"
                  onClick={handleResetPassword}
                  disabled={resetting}
                  className="text-[#2C76FF] hover:underline font-semibold disabled:opacity-50"
                >
                  {resetting ? "Sending link…" : "Resend setup link"}
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
