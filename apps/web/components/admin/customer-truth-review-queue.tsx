"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/admin/status-badge";

type CustomerTruthFact = {
  id: string;
  customerId: string;
  customerName: string;
  fieldKey: string;
  value: unknown;
  detectedAt: string;
  evidenceCount: number;
  speakers: string[];
};

function formatValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function humanizeFieldKey(fieldKey: string) {
  return fieldKey.replaceAll("_", " ");
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CustomerTruthReviewQueue({ facts }: { facts: CustomerTruthFact[] }) {
  const router = useRouter();
  const [actingOn, setActingOn] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function confirm(factId: string) {
    setActingOn(factId);
    setError(null);
    const response = await fetch(`/api/customer-truth/${factId}/confirm`, {
      method: "POST",
    });
    setActingOn(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not confirm this proposal.");
      return;
    }
    router.refresh();
  }

  async function reject(factId: string) {
    setActingOn(factId);
    setError(null);
    const response = await fetch(`/api/customer-truth/${factId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
    });
    setActingOn(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not reject this proposal.");
      return;
    }
    setRejectingId(null);
    setRejectReason("");
    router.refresh();
  }

  if (facts.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-12 text-center shadow-sm">
        <p className="text-sm text-zinc-500">No pending customer truth proposals to review.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="rounded-lg bg-[#FF5C5C]/10 border border-[#FF5C5C]/20 px-4 py-2 text-sm text-[#991B1B]">
          {error}
        </p>
      )}

      <div className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-[#1E1E1E]">Pending proposals</h2>
            <span className="text-sm text-zinc-500">{facts.length} fact{facts.length !== 1 ? "s" : ""}</span>
          </div>
        </div>

        <div className="divide-y divide-zinc-100">
          {facts.map((fact) => (
            <div key={fact.id} className="px-6 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/customers/${fact.customerId}`}
                      className="font-semibold text-[#2C76FF] hover:underline"
                    >
                      {fact.customerName}
                    </Link>
                    <span className="text-zinc-400">·</span>
                    <span className="text-sm font-medium text-[#1E1E1E]">
                      {humanizeFieldKey(fact.fieldKey)}
                    </span>
                  </div>

                  <div className="mt-2">
                    <span className="text-sm font-medium text-[#1E1E1E]">
                      {formatValue(fact.value)}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge tone="info">
                        {fact.evidenceCount} evidence segment{fact.evidenceCount !== 1 ? "s" : ""}
                      </StatusBadge>
                    </div>
                    {fact.speakers.length > 0 && (
                      <>
                        <span>·</span>
                        <span>Speakers: {fact.speakers.join(", ")}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>Detected {formatDateTime(fact.detectedAt)}</span>
                  </div>

                  {rejectingId === fact.id && (
                    <div className="mt-3 flex flex-col gap-2">
                      <textarea
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Rejection reason (optional)"
                        rows={2}
                        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-[#1E1E1E]"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => reject(fact.id)}
                          disabled={actingOn === fact.id}
                          className="rounded-md bg-[#FF5C5C] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#FF5C5C]/90 disabled:opacity-50"
                        >
                          {actingOn === fact.id ? "Rejecting…" : "Confirm rejection"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingId(null);
                            setRejectReason("");
                            setError(null);
                          }}
                          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {rejectingId !== fact.id && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => confirm(fact.id)}
                      disabled={actingOn === fact.id}
                      className="rounded-md bg-[#29FE29] px-3 py-1.5 text-sm font-medium text-[#0B1D33] hover:bg-[#29FE29]/90 disabled:opacity-50"
                    >
                      {actingOn === fact.id ? "Confirming…" : "Confirm"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectingId(fact.id)}
                      disabled={actingOn === fact.id}
                      className="rounded-md bg-[#FF5C5C] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#FF5C5C]/90 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
