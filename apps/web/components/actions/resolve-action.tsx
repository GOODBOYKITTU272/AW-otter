"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// M10: complete/dismiss buttons for one outstanding call_records row.
export function ResolveAction({ recordId }: { recordId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<
    "completed" | "cancelled" | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(resolution: "completed" | "cancelled") {
    setSubmitting(resolution);
    setError(null);
    const response = await fetch(`/api/call-records/${recordId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolution }),
    });
    setSubmitting(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not update this item.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => resolve("completed")}
          disabled={submitting !== null}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {submitting === "completed" ? "Completing…" : "Complete"}
        </button>
        <button
          type="button"
          onClick={() => resolve("cancelled")}
          disabled={submitting !== null}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
        >
          {submitting === "cancelled" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
