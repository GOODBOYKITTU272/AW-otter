"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RequestDoNotRecordAction({
  meetingId,
  alreadyPending,
}: {
  meetingId: string;
  alreadyPending: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (alreadyPending) {
    return <span className="text-xs text-zinc-400">Request pending review</span>;
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs underline">
        Request not to record
      </button>
    );
  }

  async function submit() {
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const response = await fetch("/api/recording-exceptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId, reason }),
    });
    setSubmitting(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not submit the request.");
      return;
    }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  return (
    <div className="flex w-56 flex-col gap-1.5">
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why should this meeting not be recorded?"
        rows={2}
        className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
      />
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
