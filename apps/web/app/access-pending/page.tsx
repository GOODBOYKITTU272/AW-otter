"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useState } from "react";

export default function AccessPendingPage() {
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signOut();
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Hard navigation required after sign out to clear session
    window.location.assign("/login");
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Access pending</h1>
      <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        Your account isn&apos;t linked to an active ApplyWizz organization yet.
        Contact your Admin.
      </p>
      <button
        onClick={handleSignOut}
        disabled={signingOut}
        className="mt-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </main>
  );
}
