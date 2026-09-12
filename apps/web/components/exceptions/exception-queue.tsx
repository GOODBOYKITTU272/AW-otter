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
        <h2 className="font-medium text-[#1E1E1E]">Pending review ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className="text-sm text-zinc-500">No requests waiting for review.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((request) => (
              <li key={request.id} className="rounded-lg border border-zinc-200 bg-white p-4 text-sm shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-medium text-[#1E1E1E]">{request.meetingTitle}</div>
                    <div className="text-zinc-500">
                      {request.meetingScheduledStart ? formatDateTime(request.meetingScheduledStart) : "—"} · Requested by{" "}
                      {request.requestedByName} on {formatDateTime(request.requestedAt)}
                    </div>
                  </div>
                  <StatusBadge tone={STATUS_TONE[request.status] ?? "neutral"}>{request.status}</StatusBadge>
                </div>
                <p className="mt-2 rounded-md bg-zinc-50 p-2 text-zinc-700">
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
                    className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => review(request.id, "approved")}
                      disabled={actingOn === request.id}
                      className="rounded-md bg-[#29FE29] px-3 py-1.5 font-medium text-[#0B1D33] hover:bg-[#29FE29]/90 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => review(request.id, "rejected")}
                      disabled={actingOn === request.id}
                      className="rounded-md bg-[#FF5C5C] px-3 py-1.5 font-medium text-white hover:bg-[#FF5C5C]/90 disabled:opacity-50"
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
        <h2 className="font-medium text-[#1E1E1E]">Decided</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Meeting</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Requested by</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Reviewed by</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Notes</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Decided</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {decided.map((request) => (
                <tr key={request.id} className="hover:bg-zinc-50 transition-colors">
                  <td className="px-4 py-3 text-[#1E1E1E]">{request.meetingTitle}</td>
                  <td className="px-4 py-3 text-zinc-600">{request.requestedByName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={STATUS_TONE[request.status] ?? "neutral"}>{request.status}</StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-zinc-600">{request.reviewedByName ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">{request.reviewNotes ?? "—"}</td>
                  <td className="px-4 py-3 text-zinc-600">
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
