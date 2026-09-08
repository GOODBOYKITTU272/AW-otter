"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// M10: buttons for one proposed customer_truth_facts row. Same
// fetch-then-router.refresh() shape as RequestDoNotRecordAction — the
// server-side RPC (confirm_customer_truth_fact / reject_customer_truth_fact)
// is the actual authorization/atomicity/idempotency enforcement; this
// component just surfaces its real result or real error, never guesses.
export function ConfirmRejectActions({ factId }: { factId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState<"confirm" | "reject" | null>(
    null,
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setSubmitting("confirm");
    setError(null);
    const response = await fetch(`/api/customer-truth/${factId}/confirm`, {
      method: "POST",
    });
    setSubmitting(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not confirm this proposal.");
      return;
    }
    router.refresh();
  }

  async function reject() {
    setSubmitting("reject");
    setError(null);
    const response = await fetch(`/api/customer-truth/${factId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.trim() || undefined }),
    });
    setSubmitting(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not reject this proposal.");
      return;
    }
    setRejecting(false);
    setReason("");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1.5">
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
      {rejecting ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional)"
            rows={2}
            className="w-56 rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reject}
              disabled={submitting !== null}
              className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
            >
              {submitting === "reject" ? "Rejecting…" : "Confirm reject"}
            </button>
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setError(null);
              }}
              className="rounded-md px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={confirm}
            disabled={submitting !== null}
            className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
          >
            {submitting === "confirm" ? "Confirming…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => setRejecting(true)}
            disabled={submitting !== null}
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
