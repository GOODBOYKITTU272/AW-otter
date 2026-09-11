"use client";

import Link from "next/link";
import { useState } from "react";
import type { AskSignalResult } from "@applywizz/ai";

export const GROUNDING_CONFIG: Record<
  NonNullable<AskSignalResult["groundingStatus"]>,
  { label: string; icon: string; className: string }
> = {
  supported: {
    label: "Verified from meeting",
    icon: "✓",
    className:
      "bg-emerald-50 text-emerald-800 border border-emerald-200 dark:bg-emerald-950/70 dark:text-emerald-300 dark:border-emerald-800",
  },
  partially_supported: {
    label: "Some evidence — check context",
    icon: "⚠",
    className:
      "bg-amber-50 text-amber-800 border border-amber-200 dark:bg-amber-950/70 dark:text-amber-300 dark:border-amber-800",
  },
  unsupported: {
    label: "Not supported by meeting records",
    icon: "✕",
    className:
      "bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/70 dark:text-red-300 dark:border-red-800",
  },
  needs_review: {
    label: "Please review this part",
    icon: "🔍",
    className:
      "bg-orange-50 text-orange-800 border border-orange-200 dark:bg-orange-950/70 dark:text-orange-300 dark:border-orange-800",
  },
  conflicting: {
    label: "Conflicting statements between meetings",
    icon: "⚡",
    className:
      "bg-purple-50 text-purple-800 border border-purple-200 dark:bg-purple-950/70 dark:text-purple-300 dark:border-purple-800",
  },
  insufficient_evidence: {
    label: "Echo couldn’t find enough evidence",
    icon: "—",
    className:
      "bg-zinc-100 text-zinc-700 border border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
  },
};

function formatMs(ms?: number): string {
  if (typeof ms !== "number") return "";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function SuggestedUpdateCard({
  proposal,
}: {
  proposal: NonNullable<AskSignalResult["proposedFacts"]>[number];
}) {
  const [actionState, setActionState] = useState<
    "idle" | "confirming" | "dismissing" | "confirmed" | "dismissed"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!proposal.id) return;
    setActionState("confirming");
    setError(null);
    try {
      const res = await fetch(`/api/customer-truth/${proposal.id}/confirm`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to confirm update.");
        setActionState("idle");
        return;
      }
      setActionState("confirmed");
    } catch {
      setError("Network error confirming update.");
      setActionState("idle");
    }
  }

  async function handleDismiss() {
    if (!proposal.id) {
      setActionState("dismissed");
      return;
    }
    setActionState("dismissing");
    setError(null);
    try {
      const res = await fetch(`/api/customer-truth/${proposal.id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Dismissed by AM in Echo panel" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to dismiss update.");
        setActionState("idle");
        return;
      }
      setActionState("dismissed");
    } catch {
      setError("Network error dismissing update.");
      setActionState("idle");
    }
  }

  if (actionState === "confirmed") {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/80 dark:text-emerald-200">
        ✓ Update confirmed and saved to Customer Truth.
      </div>
    );
  }

  if (actionState === "dismissed") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Suggested update dismissed. Customer Truth unchanged.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50/70 p-3.5 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-amber-900 dark:text-amber-200">
          Suggested Update
        </span>
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/60 dark:text-amber-300">
          Requires your confirmation
        </span>
      </div>

      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        <span className="capitalize">{proposal.fieldKey.replaceAll("_", " ")}</span>
        {" → "}
        <span className="font-semibold text-blue-700 dark:text-blue-400">
          {(() => {
            const val = proposal.proposedValue;
            if (typeof val === "string") return val;
            if (Array.isArray(val)) return val.join(", ");
            return JSON.stringify(val);
          })()}
        </span>
      </div>

      {proposal.rationale ? (
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {proposal.rationale}
        </p>
      ) : null}

      {(proposal.speakerName || proposal.speakerRole || proposal.timestampMs) && (
        <div className="text-xs text-zinc-600 dark:text-zinc-400">
          Spoken by:{" "}
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            {proposal.speakerName ?? proposal.speakerRole ?? "Attendee"}
          </span>
          {proposal.speakerRole && proposal.speakerName
            ? ` · ${proposal.speakerRole}`
            : ""}
          {typeof proposal.timestampMs === "number"
            ? ` · ${formatMs(proposal.timestampMs)}`
            : ""}
        </div>
      )}

      {error ? (
        <div role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-2 pt-1.5 border-t border-amber-200/60 dark:border-amber-900/40">
        {proposal.id ? (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={actionState !== "idle"}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {actionState === "confirming" ? "Confirming…" : "Confirm Update"}
          </button>
        ) : (
          <span className="text-[11px] text-zinc-500 italic dark:text-zinc-400">
            Read-only proposal (not persisted to review queue)
          </span>
        )}

        <button
          type="button"
          onClick={handleDismiss}
          disabled={actionState !== "idle"}
          className="rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {actionState === "dismissing" ? "Dismissing…" : "Dismiss"}
        </button>

        {proposal.sourceMeetingId && proposal.evidenceSegmentId ? (
          <Link
            href={`/meetings/${proposal.sourceMeetingId}?tab=transcript#segment-${proposal.evidenceSegmentId}`}
            className="ml-auto text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            View in transcript →
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function AskSignalPanel({ customerId }: { customerId: string }) {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskSignalResult | null>(null);

  async function ask() {
    const trimmed = question.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    const response = await fetch(`/api/customers/${customerId}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: trimmed }),
    });
    const body = await response.json().catch(() => ({}));
    setSubmitting(false);
    if (!response.ok) {
      setError(body.error ?? "Echo could not answer that right now.");
      return;
    }
    setResult(body.result as AskSignalResult);
  }

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="ask-echo-question"
          className="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
        >
          Ask Echo about this customer
        </label>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Echo searches recorded meetings, transcripts, and commitments for verified evidence.
        </p>
        <textarea
          id="ask-echo-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="e.g. What did the candidate say about relocation?"
          className="w-full rounded-lg border border-zinc-300 p-3 text-sm focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={ask}
          disabled={submitting || question.trim().length === 0}
          className="self-start rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-600 dark:hover:bg-blue-500"
        >
          {submitting ? "Searching meetings…" : "Ask Echo"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
          {result.groundingStatus && GROUNDING_CONFIG[result.groundingStatus] ? (
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${GROUNDING_CONFIG[result.groundingStatus].className}`}
              >
                <span>{GROUNDING_CONFIG[result.groundingStatus].icon}</span>
                <span>{GROUNDING_CONFIG[result.groundingStatus].label}</span>
              </span>
            </div>
          ) : null}

          <div className="rounded-lg bg-zinc-50/70 p-4 text-sm text-zinc-900 dark:bg-zinc-900/60 dark:text-zinc-100 leading-relaxed">
            {result.answer}
          </div>

          {result.integrityWarning ? (
            <div className="rounded-lg bg-orange-50 p-3 text-xs text-orange-900 border border-orange-200 dark:bg-orange-950/60 dark:text-orange-200 dark:border-orange-800">
              <span className="font-semibold">Notice: </span>
              {result.integrityWarning}
            </div>
          ) : null}

          {result.unresolvedAmbiguity ? (
            <p className="text-xs italic text-zinc-500 dark:text-zinc-400">
              Note: {result.unresolvedAmbiguity}
            </p>
          ) : null}

          {result.proposedFacts && result.proposedFacts.length > 0 ? (
            <div className="flex flex-col gap-2">
              {result.proposedFacts.map((pf) => (
                <SuggestedUpdateCard
                  key={pf.id ?? pf.fieldKey}
                  proposal={pf}
                />
              ))}
            </div>
          ) : null}

          {result.evidence.length > 0 ? (
            <div className="flex flex-col gap-2.5">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                Meeting Evidence ({result.evidence.length})
              </span>
              <ul className="flex flex-col gap-2">
                {result.evidence.map((item) => {
                  const speakerDisplay = item.speakerName
                    ? `${item.speakerName} · ${item.speakerRole ?? "Attendee"}`
                    : item.speakerRole ?? "Attendee";
                  const timeDisplay = formatMs(item.startMs ?? undefined);

                  return (
                    <li
                      key={`${item.type}:${item.id}`}
                      className="flex flex-col gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3.5 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                          {speakerDisplay}
                          {timeDisplay ? (
                            <span className="ml-2 font-normal text-zinc-500 dark:text-zinc-400">
                              · {timeDisplay}
                            </span>
                          ) : null}
                        </span>
                        {item.type === "transcript_segment" && item.meetingId ? (
                          <Link
                            href={`/meetings/${item.meetingId}?tab=transcript#segment-${item.id}`}
                            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                          >
                            Jump to transcript →
                          </Link>
                        ) : null}
                      </div>
                      <blockquote className="border-l-2 border-zinc-300 pl-2.5 italic text-zinc-700 dark:border-zinc-700 dark:text-zinc-300">
                        &ldquo;{item.text}&rdquo;
                      </blockquote>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {result.followUpSuggestions.length > 0 ? (
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
                Suggested questions:
              </span>
              <div className="flex flex-wrap gap-1.5">
                {result.followUpSuggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      setQuestion(s);
                    }}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 text-left"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
