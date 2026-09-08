"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// M10 amendment: explicit, human-triggered CRM baseline refresh — never
// automatic on page load (that would mean an external API call on every
// view). §14: a failed refresh never corrupts the existing baseline, so
// this component just surfaces the real error and leaves the page as-is.
export function RefreshCrmButton({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/api/customers/${customerId}/hydrate-crm`, {
      method: "POST",
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not refresh from the CRM.");
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
      <button
        type="button"
        onClick={refresh}
        disabled={submitting}
        className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
      >
        {submitting ? "Refreshing…" : "Refresh from CRM"}
      </button>
    </div>
  );
}
