"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";

export type ExceptionRequestRow = {
  id: string;
  reason: string;
  status: string;
  reviewNotes: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  meetingTitle: string;
  meetingScheduledStart: string | null;
  requestedByName: string;
  reviewedByName: string | null;
};

const STATUS_TONE: Record<string, BadgeTone> = {
  requested: "warning",
  approved: "success",
  rejected: "critical",
  cancelled: "neutral",
  expired: "neutral",
};

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Shared between /admin/exceptions and the manager queue — the query
 * differs (admin sees the whole org, manager sees only their reporting
 * tree via private.is_manager_of), the review UI is identical either way.
 */
export function ExceptionQueue({ requests }: { requests: ExceptionRequestRow[] }) {
  const router = useRouter();
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [notesByRequest, setNotesByRequest] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function review(requestId: string, decision: "approved" | "rejected") {
    setActingOn(requestId);
    setError(null);
    const response = await fetch(`/api/recording-exceptions/${requestId}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reviewNotes: notesByRequest[requestId] ?? "" }),
    });
    setActingOn(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not submit the review.");
      return;
    }
    router.refresh();
  }

  const pending = requests.filter((r) => r.status === "requested");
  const decided = requests.filter((r) => r.status !== "requested");

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Pending review ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No requests waiting for review.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((request) => (
              <li key={request.id} className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium">{request.meetingTitle}</div>
                    <div className="text-zinc-500 dark:text-zinc-400">
                      {request.meetingScheduledStart ? formatDateTime(request.meetingScheduledStart) : "—"} · Requested by{" "}
                      {request.requestedByName} on {formatDateTime(request.requestedAt)}
                    </div>
                  </div>
                  <StatusBadge tone={STATUS_TONE[request.status] ?? "neutral"}>{request.status}</StatusBadge>
                </div>
                <p className="mt-2 rounded-md bg-zinc-50 p-2 text-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300">
                  &ldquo;{request.reason}&rdquo;
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input
                    type="text"
                    placeholder="Review notes (optional)"
                    value={notesByRequest[request.id] ?? ""}
                    onChange={(event) =>
                      setNotesByRequest((prev) => ({ ...prev, [request.id]: event.target.value }))
                    }
                    className="flex-1 rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => review(request.id, "approved")}
                      disabled={actingOn === request.id}
                      className="rounded-md bg-green-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => review(request.id, "rejected")}
                      disabled={actingOn === request.id}
                      className="rounded-md bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Decided</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Meeting</th>
                <th className="px-4 py-2.5">Requested by</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Reviewed by</th>
                <th className="px-4 py-2.5">Notes</th>
                <th className="px-4 py-2.5">Decided</th>
              </tr>
            </thead>
            <tbody>
              {decided.map((request) => (
                <tr key={request.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                  <td className="px-4 py-2.5">{request.meetingTitle}</td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{request.requestedByName}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge tone={STATUS_TONE[request.status] ?? "neutral"}>{request.status}</StatusBadge>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{request.reviewedByName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{request.reviewNotes ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                    {request.reviewedAt ? formatDateTime(request.reviewedAt) : "—"}
                  </td>
                </tr>
              ))}
              {decided.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                    No decided requests yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
