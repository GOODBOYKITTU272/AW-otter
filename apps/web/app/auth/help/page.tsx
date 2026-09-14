"use client";

import { useState, type FormEvent } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { ArrowLeft } from "lucide-react";
import { isAllowedEmailDomain } from "@applywizz/auth";
import Link from "next/link";

type HelpStep = "email" | "email-otp" | "totp-reenroll" | "success";

export default function AuthHelpPage() {
  const [step, setStep] = useState<HelpStep>("email");
  const [email, setEmail] = useState("");
  const [emailOtp, setEmailOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const [totpQrCode, setTotpQrCode] = useState("");
  const [totpCode, setTotpCode] = useState<string[]>(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    const trimmedEmail = email.trim().toLowerCase();

    if (!isAllowedEmailDomain(trimmedEmail)) {
      setError("Only @applywizz.ai emails can sign in.");
      setSubmitting(false);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        shouldCreateUser: false,
      },
    });

    if (otpError) {
      setError(
        "Failed to send email code. Please ensure you have an active account.",
      );
      setSubmitting(false);
      return;
    }

    setSuccessMessage(`Code sent to ${trimmedEmail}`);
    setStep("email-otp");
    setSubmitting(false);
  }

  async function handleEmailOtpSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const otpValue = emailOtp.join("");
    if (otpValue.length !== 6) {
      setError("Please enter the complete 6-digit code.");
      setSubmitting(false);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const { error: verifyError, data } = await supabase.auth.verifyOtp({
      email: email.trim().toLowerCase(),
      token: otpValue,
      type: "email",
    });

    if (verifyError) {
      setError("Invalid or expired code. Please try again.");
      setSubmitting(false);
      return;
    }

    if (!data.session) {
      setError("Failed to establish session. Please try again.");
      setSubmitting(false);
      return;
    }

    const { data: factors } = await supabase.auth.mfa.listFactors();
    const existingFactors = factors?.totp ?? [];

    for (const factor of existingFactors) {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }

    const { data: enrollData, error: enrollError } =
      await supabase.auth.mfa.enroll({
        factorType: "totp",
        issuer: "AW Echo",
        friendlyName: "AW Echo",
      });

    if (enrollError || !enrollData) {
      setError("Failed to initialize authenticator setup.");
      setSubmitting(false);
      return;
    }

    setTotpQrCode(enrollData.totp.qr_code);
    setStep("totp-reenroll");
    setSubmitting(false);
  }

  async function handleTotpReenrollSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const code = totpCode.join("");
    if (code.length !== 6) {
      setError("Please enter the complete 6-digit code.");
      setSubmitting(false);
      return;
    }

    const supabase = getSupabaseBrowserClient();
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const unverifiedFactor = factors?.totp?.find(
      (f) => f.status === "unverified",
    );

    if (!unverifiedFactor) {
      setError("No pending authenticator enrollment found.");
      setSubmitting(false);
      return;
    }

    const { error: challengeError, data: challengeData } =
      await supabase.auth.mfa.challenge({
        factorId: unverifiedFactor.id,
      });

    if (challengeError || !challengeData) {
      setError("Failed to verify code.");
      setSubmitting(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: unverifiedFactor.id,
      challengeId: challengeData.id,
      code,
    });

    if (verifyError) {
      setError("Invalid code. Please try again.");
      setSubmitting(false);
      return;
    }

    setStep("success");
    setSubmitting(false);
  }

  function handleEmailOtpChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    if (value.length > 1) value = value[0];

    const newOtp = [...emailOtp];
    newOtp[index] = value;
    setEmailOtp(newOtp);

    if (value && index < 5) {
      const nextInput = document.getElementById(
        `email-otp-${index + 1}`,
      ) as HTMLInputElement;
      nextInput?.focus();
    }
  }

  function handleTotpCodeChange(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    if (value.length > 1) value = value[0];

    const newCode = [...totpCode];
    newCode[index] = value;
    setTotpCode(newCode);

    if (value && index < 5) {
      const nextInput = document.getElementById(
        `totp-${index + 1}`,
      ) as HTMLInputElement;
      nextInput?.focus();
    }
  }

  function handleBackToStart() {
    setStep("email");
    setEmail("");
    setEmailOtp(["", "", "", "", "", ""]);
    setTotpCode(["", "", "", "", "", ""]);
    setError(null);
    setSuccessMessage(null);
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] to-[#1E1E1E] px-4 sm:px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6 sm:mb-8">
          <Link
            href="/login"
            className="inline-flex items-center gap-3 mb-4 sm:mb-6 hover:opacity-80 transition-opacity"
          >
            <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center shadow-lg">
              <span className="text-xl font-bold text-white">AW</span>
            </div>
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-2">
            {step === "email" && "Need help signing in"}
            {step === "email-otp" && "Enter 6-digit email OTP"}
            {step === "totp-reenroll" && "Re-enroll Microsoft Authenticator"}
            {step === "success" && "Authenticator reset complete"}
          </h1>
          <p className="text-sm text-[#F5F5F5]/70">
            {step === "email" &&
              "Enter your email to reset your authenticator."}
            {step === "email-otp" &&
              "Check your inbox (and spam) for the code we sent."}
            {step === "totp-reenroll" &&
              "Scan the QR code with Microsoft Authenticator."}
            {step === "success" &&
              "You can now sign in with your new authenticator."}
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/90 backdrop-blur-xl p-6 sm:p-8 shadow-2xl">
          {step === "email" && (
            <form onSubmit={handleEmailSubmit} className="flex flex-col gap-6">
              <div className="flex items-start gap-2 text-xs text-[#2C76FF] bg-[#2C76FF]/10 rounded-lg px-4 py-3">
                <svg
                  className="h-4 w-4 shrink-0 mt-0.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span>
                  Lost access to your authenticator? We&apos;ll send you an email
                  code to verify your identity, then help you re-enroll.
                </span>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-white flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-[#2C76FF]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  Work email
                </label>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="rounded-xl border border-white/10 bg-[#0B1D33]/80 px-4 py-3.5 text-sm text-white placeholder-[#F5F5F5]/40 focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/30 transition-all min-h-[48px]"
                  placeholder="you@applywizz.ai"
                />
              </div>

              {successMessage && (
                <div
                  role="status"
                  className="rounded-xl border border-[#29FE29]/30 bg-[#29FE29]/10 px-4 py-3.5 text-sm text-[#29FE29] flex items-center gap-3"
                >
                  <svg
                    className="h-5 w-5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  {successMessage}
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-[#FF5C5C]/30 bg-[#FF5C5C]/10 px-4 py-3.5 text-sm text-[#FF5C5C] flex items-center gap-3"
                >
                  <svg
                    className="h-5 w-5 shrink-0"
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
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 rounded-xl bg-[#29FE29] px-6 py-4 text-base font-bold text-[#1E1E1E] hover:bg-[#29FE29]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-[#29FE29]/20 flex items-center justify-center gap-2 min-h-[56px]"
              >
                {submitting ? (
                  <>
                    <svg
                      className="animate-spin h-5 w-5"
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
                    Sending code…
                  </>
                ) : (
                  <>
                    Send email code
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 7l5 5m0 0l-5 5m5-5H6"
                      />
                    </svg>
                  </>
                )}
              </button>

              <div className="flex flex-col gap-2 mt-2">
                <Link
                  href="/login"
                  className="flex items-center justify-center gap-2 text-sm text-[#2C76FF] hover:underline"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Sign In
                </Link>
              </div>
            </form>
          )}

          {step === "email-otp" && (
            <form
              onSubmit={handleEmailOtpSubmit}
              className="flex flex-col gap-6"
            >
              <button
                type="button"
                onClick={handleBackToStart}
                className="flex items-center gap-2 text-sm text-[#2C76FF] hover:underline self-start"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-white">
                  Email code (6 digits)
                </label>
                <div className="flex gap-2 justify-between">
                  {emailOtp.map((digit, index) => (
                    <input
                      key={index}
                      id={`email-otp-${index}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) =>
                        handleEmailOtpChange(index, e.target.value)
                      }
                      className="w-12 h-12 rounded-xl border border-white/10 bg-[#0B1D33]/80 text-center text-lg font-bold text-white focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/30 transition-all"
                    />
                  ))}
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-[#FF5C5C]/30 bg-[#FF5C5C]/10 px-4 py-3.5 text-sm text-[#FF5C5C] flex items-center gap-3"
                >
                  <svg
                    className="h-5 w-5 shrink-0"
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
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 rounded-xl bg-[#29FE29] px-6 py-4 text-base font-bold text-[#1E1E1E] hover:bg-[#29FE29]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-[#29FE29]/20 flex items-center justify-center gap-2 min-h-[56px]"
              >
                {submitting ? (
                  <>
                    <svg
                      className="animate-spin h-5 w-5"
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
                    Verifying…
                  </>
                ) : (
                  <>
                    Verify
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </>
                )}
              </button>
            </form>
          )}

          {step === "totp-reenroll" && (
            <form
              onSubmit={handleTotpReenrollSubmit}
              className="flex flex-col gap-6"
            >
              <div className="flex flex-col items-center gap-4">
                <div className="bg-white p-4 rounded-xl">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={totpQrCode}
                    alt="QR Code for Microsoft Authenticator"
                    className="w-48 h-48"
                  />
                </div>
                <div className="text-sm text-[#F5F5F5]/80 space-y-2 text-center">
                  <p className="flex items-center gap-2 justify-center">
                    <svg
                      className="h-4 w-4 text-[#2C76FF]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                      />
                    </svg>
                    Open Microsoft Authenticator
                  </p>
                  <p className="flex items-center gap-2 justify-center">
                    <svg
                      className="h-4 w-4 text-[#29FE29]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    Add account
                  </p>
                  <p className="flex items-center gap-2 justify-center">
                    <svg
                      className="h-4 w-4 text-[#2C76FF]"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                      />
                    </svg>
                    Scan QR
                  </p>
                  <p className="text-[#29FE29] font-bold">
                    Account name must be <strong>AW Echo</strong>
                  </p>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-sm font-semibold text-white">
                  Authenticator code (6 digits)
                </label>
                <div className="flex gap-2 justify-between">
                  {totpCode.map((digit, index) => (
                    <input
                      key={index}
                      id={`totp-${index}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) =>
                        handleTotpCodeChange(index, e.target.value)
                      }
                      className="w-12 h-12 rounded-xl border border-white/10 bg-[#0B1D33]/80 text-center text-lg font-bold text-white focus:border-[#2C76FF] focus:outline-none focus:ring-2 focus:ring-[#2C76FF]/30 transition-all"
                    />
                  ))}
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-xl border border-[#FF5C5C]/30 bg-[#FF5C5C]/10 px-4 py-3.5 text-sm text-[#FF5C5C] flex items-center gap-3"
                >
                  <svg
                    className="h-5 w-5 shrink-0"
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
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="mt-2 rounded-xl bg-[#29FE29] px-6 py-4 text-base font-bold text-[#1E1E1E] hover:bg-[#29FE29]/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-xl shadow-[#29FE29]/20 flex items-center justify-center gap-2 min-h-[56px]"
              >
                {submitting ? (
                  <>
                    <svg
                      className="animate-spin h-5 w-5"
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
                    Verifying…
                  </>
                ) : (
                  <>
                    Verify & Finish
                    <svg
                      className="h-5 w-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </>
                )}
              </button>
            </form>
          )}

          {step === "success" && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="h-16 w-16 rounded-full bg-[#29FE29]/20 flex items-center justify-center">
                  <svg
                    className="h-8 w-8 text-[#29FE29]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-white mb-2">
                    Authenticator reset complete!
                  </h2>
                  <p className="text-sm text-[#F5F5F5]/70">
                  Your new Microsoft Authenticator (AW Echo) is ready. You
                  can now sign in with your email and the code from your
                  authenticator app.
                  </p>
                </div>
              </div>

              <Link
                href="/login"
                className="mt-2 rounded-xl bg-[#29FE29] px-6 py-4 text-base font-bold text-[#1E1E1E] hover:bg-[#29FE29]/90 transition-all shadow-xl shadow-[#29FE29]/20 flex items-center justify-center gap-2 min-h-[56px]"
              >
                Go to Sign In
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 7l5 5m0 0l-5 5m5-5H6"
                  />
                </svg>
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
