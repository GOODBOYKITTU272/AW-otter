import Link from "next/link";

/**
 * Branded marketing landing page for unauthenticated users.
 * Brand guidelines:
 * - Colors: Jet Black #1E1E1E, Fluorescent Green #29FE29, Bright Blue #2C76FF, Soft Gray #F5F5F5, Navy #0B1D33
 * - Fonts: Noto Sans primary; round CTAs
 * - CTAs: Sign in + Request access (invite-only — NO open Create account / self-serve signup)
 * - Logo assets: logo_Applywizz.png and otter Echo logo should be placed in apps/web/public/
 */
export function LandingPage() {
  return (
    <div className="min-h-screen bg-[#0B1D33] flex flex-col">
      {/* Header */}
      <header className="border-b border-white/10 bg-[#1E1E1E]/50 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-2xl font-bold text-[#29FE29]">
                Apply Wizz Echo
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/login"
                className="rounded-full bg-white/10 px-5 py-2 text-sm font-semibold text-white hover:bg-white/20 transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/access-pending"
                className="rounded-full bg-[#2C76FF] px-5 py-2 text-sm font-semibold text-white hover:bg-[#2C76FF]/90 transition-colors shadow-lg shadow-[#2C76FF]/20"
              >
                Request access
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className="py-20 lg:py-32">
            <div className="mx-auto max-w-3xl text-center">
              <h1 className="text-5xl font-bold tracking-tight text-white lg:text-7xl">
                <span className="text-[#29FE29]">Echo</span> remembers{" "}
                <span className="text-white">every</span> customer conversation
              </h1>
              <p className="mt-6 text-lg leading-8 text-[#F5F5F5]/80">
                ApplyWizz Echo joins your customer meetings, captures every
                detail, and keeps your team aligned—automatically. No more
                manual notes, no more missed commitments.
              </p>
              <div className="mt-10 flex items-center justify-center gap-6">
                <Link
                  href="/login"
                  className="rounded-full bg-[#29FE29] px-8 py-3.5 text-base font-semibold text-[#1E1E1E] hover:bg-[#29FE29]/90 transition-colors shadow-xl shadow-[#29FE29]/20"
                >
                  Get started
                </Link>
                <Link
                  href="/access-pending"
                  className="rounded-full border border-white/20 px-8 py-3.5 text-base font-semibold text-white hover:bg-white/5 transition-colors"
                >
                  Request invitation
                </Link>
              </div>
            </div>

            {/* Features Grid */}
            <div className="mt-24 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/50 p-8 backdrop-blur-sm">
                <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#2C76FF]/20">
                  <svg
                    className="h-6 w-6 text-[#2C76FF]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white">
                  {process.env.NEXT_PUBLIC_ENABLE_VIDEO_RECORDING === "true"
                    ? "Meeting recording"
                    : "Audio-only recording"}
                </h3>
                <p className="mt-2 text-sm text-[#F5F5F5]/70">
                  {process.env.NEXT_PUBLIC_ENABLE_VIDEO_RECORDING === "true"
                    ? "Captures audio and screen share from every meeting. Full context without intrusive camera recording."
                    : "Captures high-quality audio from every meeting. No screen or video recording—privacy-first by design."}
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/50 p-8 backdrop-blur-sm">
                <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#29FE29]/20">
                  <svg
                    className="h-6 w-6 text-[#29FE29]"
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
                </div>
                <h3 className="text-xl font-semibold text-white">
                  Intelligent capture
                </h3>
                <p className="mt-2 text-sm text-[#F5F5F5]/70">
                  Automatically extracts commitments, action items, and key
                  decisions from every conversation.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-[#1E1E1E]/50 p-8 backdrop-blur-sm">
                <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[#2C76FF]/20">
                  <svg
                    className="h-6 w-6 text-[#2C76FF]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-semibold text-white">
                  Team alignment
                </h3>
                <p className="mt-2 text-sm text-[#F5F5F5]/70">
                  Keep managers and stakeholders in sync with real-time updates
                  and comprehensive meeting intelligence.
                </p>
              </div>
            </div>

            {/* How It Works */}
            <div className="mt-24">
              <h2 className="text-center text-3xl font-bold text-white">
                How it works
              </h2>
              <div className="mt-12 grid gap-8 sm:grid-cols-3">
                <div className="text-center">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#29FE29]/20 text-2xl font-bold text-[#29FE29]">
                    1
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-white">
                    Schedule normally
                  </h3>
                  <p className="mt-2 text-sm text-[#F5F5F5]/70">
                    Book your customer meetings as usual. Echo automatically
                    detects and prepares to join.
                  </p>
                </div>
                <div className="text-center">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#2C76FF]/20 text-2xl font-bold text-[#2C76FF]">
                    2
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-white">
                    Echo joins & listens
                  </h3>
                  <p className="mt-2 text-sm text-[#F5F5F5]/70">
                    Your personalized Echo bot joins the meeting and captures
                    high-quality audio throughout.
                  </p>
                </div>
                <div className="text-center">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#29FE29]/20 text-2xl font-bold text-[#29FE29]">
                    3
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-white">
                    Instant insights
                  </h3>
                  <p className="mt-2 text-sm text-[#F5F5F5]/70">
                    Get structured meeting intelligence, action items, and
                    customer truth updates—immediately.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/10 bg-[#1E1E1E]/50 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
          <p className="text-center text-sm text-[#F5F5F5]/60">
            © {new Date().getFullYear()} ApplyWizz. All rights reserved.
            Invite-only access.
          </p>
        </div>
      </footer>
    </div>
  );
}
