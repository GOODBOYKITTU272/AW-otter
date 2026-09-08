"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface CandidateCustomer {
  id: string;
  name: string;
}

const NEEDS_LINK_REASON_LABEL: Record<string, string> = {
  no_match: "No matching customer contact found",
  multiple_matches: "More than one customer matched — pick the right one",
  owner_conflict:
    "A match exists, but it belongs to a different Account Manager",
};

/**
 * Resolution control for a single needs_link meeting (design doc §6). Only
 * ever offers customers owned by THIS meeting's own AM — the same-AM
 * ownership rule the linkage algorithm itself enforces, mirrored here so
 * the dropdown can't even present an invalid choice.
 */
export function CustomerLinkControl({
  meetingId,
  needsLinkReason,
  candidates,
}: {
  meetingId: string;
  needsLinkReason: string | null;
  candidates: CandidateCustomer[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "create">("idle");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitJson(url: string, body: unknown) {
    setSubmitting(true);
    setError(null);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSubmitting(false);
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      setError(responseBody.error ?? "Something went wrong.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function linkExisting() {
    if (!selectedCustomerId) {
      setError("Choose a customer first.");
      return;
    }
    await submitJson(`/api/meetings/${meetingId}/customer-link`, {
      customerId: selectedCustomerId,
    });
  }

  async function createAndLink() {
    if (newName.trim().length === 0) {
      setError("A customer name is required.");
      return;
    }
    const ok = await submitJson("/api/customers", {
      name: newName,
      contactEmail: newEmail || undefined,
      linkMeetingId: meetingId,
    });
    if (ok) {
      setNewName("");
      setNewEmail("");
      setMode("idle");
    }
  }

  async function leaveUnlinked() {
    await submitJson(`/api/meetings/${meetingId}/customer-unlink`, {});
  }

  return (
    <div className="flex w-64 flex-col gap-1.5">
      <span className="text-xs text-amber-700 dark:text-amber-400">
        {needsLinkReason
          ? (NEEDS_LINK_REASON_LABEL[needsLinkReason] ?? needsLinkReason)
          : "Needs a customer link"}
      </span>
      {error ? (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      ) : null}

      {mode === "idle" && (
        <>
          <div className="flex gap-1.5">
            <select
              value={selectedCustomerId}
              onChange={(event) => setSelectedCustomerId(event.target.value)}
              className="flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="">Choose customer…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={linkExisting}
              disabled={submitting}
              className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
            >
              Link
            </button>
          </div>
          <div className="flex gap-3 text-xs">
            <button
              type="button"
              onClick={() => setMode("create")}
              className="underline"
            >
              Create new customer
            </button>
            <button
              type="button"
              onClick={leaveUnlinked}
              disabled={submitting}
              className="text-zinc-500 underline dark:text-zinc-400"
            >
              Leave unlinked
            </button>
          </div>
        </>
      )}

      {mode === "create" && (
        <div className="flex flex-col gap-1.5">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Customer name"
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <input
            value={newEmail}
            onChange={(event) => setNewEmail(event.target.value)}
            placeholder="Contact email (optional)"
            className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={createAndLink}
              disabled={submitting}
              className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
            >
              {submitting ? "Creating…" : "Create & link"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="rounded-md px-2 py-1 text-xs text-zinc-500 dark:text-zinc-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
