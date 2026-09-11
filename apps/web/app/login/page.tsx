"use client";

import { useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Eye, EyeOff } from "lucide-react";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] via-[#1E1E1E] to-[#1E1E1E] px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="h-10 w-10 rounded-lg bg-[#29FE29] flex items-center justify-center">
              <span className="text-xl font-bold text-[#1E1E1E]">AW</span>
            </div>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Apply Wizz Echo
          </h1>
          <p className="mt-2 text-sm text-[#F5F5F5]/70">
            Remembers every customer conversation.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/80 backdrop-blur-sm p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-white">
                Work email
              </label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="rounded-lg border border-white/10 bg-[#0B1D33]/50 px-4 py-3 text-sm text-white placeholder-[#F5F5F5]/30 focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/20 transition-all"
                placeholder="you@company.com"
              />
            </div>

            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-white">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-[#0B1D33]/50 px-4 py-3 pr-11 text-sm text-white placeholder-[#F5F5F5]/30 focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/20 transition-all"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#F5F5F5]/50 hover:text-white transition-colors"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>

            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-[#FF5C5C]/20 bg-[#FF5C5C]/10 px-4 py-3 text-sm text-[#FF5C5C]"
              >
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 rounded-lg bg-[#29FE29] px-4 py-3 text-sm font-semibold text-[#1E1E1E] hover:bg-[#29FE29]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-[#29FE29]/20"
            >
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-[#F5F5F5]/50">
            Invite-only access · Contact your admin for account access
          </p>
        </div>
      </div>
    </main>
  );
}
