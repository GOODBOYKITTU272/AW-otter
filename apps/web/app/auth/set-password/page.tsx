"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Deprecated password-based flow. Now using email OTP + TOTP MFA.
 * Redirect users to the login page instead.
 */
export default function SetPasswordPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/login");
  }, [router]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Redirecting to login…
      </p>
    </main>
  );
}
