export default function Loading() {
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6 bg-gradient-to-br from-[#0B1D33] to-[#1E1E1E] px-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#1E1E1E]/90 backdrop-blur-xl p-8 shadow-2xl text-center">
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
      </div>
    </main>
  );
}
