"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RegenerateOutcomeButton({
  meetingId,
  className,
}: {
  meetingId: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/outcome/regenerate`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? "Could not regenerate outcome.");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not regenerate outcome.");
    } finally {
      setBusy(false);
    }
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
        onClick={onClick}
        disabled={busy}
        className={className}
      >
        {busy ? "Regenerating…" : "Regenerate outcome"}
      </button>
    </div>
  );
}
