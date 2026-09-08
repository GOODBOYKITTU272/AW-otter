"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const CALL_TYPES: { value: string; label: string }[] = [
  { value: "discovery", label: "Discovery" },
  { value: "resume_review", label: "Resume Review" },
  { value: "orientation", label: "Orientation" },
  { value: "progress", label: "Progress Review" },
  { value: "renewal", label: "Renewal" },
  { value: "other_unknown", label: "Other / Unknown" },
];

/**
 * Never inferred (design doc §5) — the AM always picks one explicitly.
 * Only rendered for a meeting that's already linked to a customer
 * (confirmCallType itself rejects an unlinked meeting).
 */
export function CallTypeConfirmControl({ meetingId }: { meetingId: string }) {
  const router = useRouter();
  const [callType, setCallType] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!callType) {
      setError("Choose a call type first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const response = await fetch(`/api/meetings/${meetingId}/call-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callType }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not confirm the call type.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <select
          value={callType}
          onChange={(event) => setCallType(event.target.value)}
          className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">What kind of call is this?</option>
          {CALL_TYPES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={confirm}
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          Confirm
        </button>
      </div>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
