"use client";

import Link from "next/link";
import { useState } from "react";
import type { AskSignalResult } from "@applywizz/ai";

const ANSWERABILITY_LABEL: Record<AskSignalResult["answerability"], string> = {
  answered: "Answered",
  partially_answered: "Partially answered",
  insufficient_evidence: "Insufficient evidence",
};

const GROUNDING_CONFIG: Record<
  NonNullable<AskSignalResult["groundingStatus"]>,
  { label: string; className: string }
> = {
  supported: {
    label: "Supported",
    className:
      "bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  },
  partially_supported: {
    label: "Partially supported",
    className:
      "bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  },
  unsupported: {
    label: "Unsupported",
    className:
      "bg-red-50 text-red-700 border border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800",
  },
  needs_review: {
    label: "Needs Review",
    className:
      "bg-orange-50 text-orange-700 border border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800",
  },
  conflicting: {
    label: "Conflicting",
    className:
      "bg-purple-50 text-purple-700 border border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
  },
  insufficient_evidence: {
    label: "Insufficient evidence",
    className:
      "bg-zinc-100 text-zinc-600 border border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700",
  },
};

// M13 / P4A Trust UI: question box, verified answer, grounding badges,
// and immutable evidence citations with segment jump affordance.
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
      setError(body.error ?? "Ask Signal could not answer that right now.");
      return;
    }
    setResult(body.result as AskSignalResult);
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="ask-signal-question"
          className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
        >
          Ask Signal about this customer
        </label>
        <textarea
          id="ask-signal-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="e.g. What did we promise them last call?"
          className="rounded-md border border-zinc-300 p-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="button"
          onClick={ask}
          disabled={submitting || question.trim().length === 0}
          className="self-start rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {submitting ? "Asking…" : "Ask"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              {ANSWERABILITY_LABEL[result.answerability]}
            </span>
            {result.groundingStatus && GROUNDING_CONFIG[result.groundingStatus] ? (
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${GROUNDING_CONFIG[result.groundingStatus].className}`}
              >
                {GROUNDING_CONFIG[result.groundingStatus].label}
              </span>
            ) : null}
          </div>

          <p className="text-sm text-zinc-900 dark:text-zinc-100">
            {result.answer}
          </p>

          {result.integrityWarning ? (
            <div className="rounded-md bg-orange-50 p-2.5 text-xs text-orange-800 border border-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-800">
              <span className="font-semibold">Integrity Warning: </span>
              {result.integrityWarning}
            </div>
          ) : null}

          {result.unresolvedAmbiguity ? (
            <p className="text-sm italic text-zinc-500 dark:text-zinc-400">
              {result.unresolvedAmbiguity}
            </p>
          ) : null}

          {result.proposedFacts && result.proposedFacts.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-md bg-amber-50 p-2.5 text-xs text-amber-900 border border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800">
              <span className="font-semibold">AI Proposed Fact (Awaiting AM Approval):</span>
              <ul className="list-inside list-disc">
                {result.proposedFacts.map((pf) => (
                  <li key={pf.fieldKey}>
                    <span className="font-medium">{pf.fieldKey}</span>: {JSON.stringify(pf.proposedValue)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.evidence.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Verified Evidence (Immutable)
              </span>
              <ul className="flex flex-col gap-1.5">
                {result.evidence.map((item) => (
                  <li
                    key={`${item.type}:${item.id}`}
                    className="flex flex-col gap-1 rounded-md bg-zinc-50 p-2.5 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{item.label}</span>
                      {item.type === "transcript_segment" && item.meetingId ? (
                        <Link
                          href={`/meetings/${item.meetingId}#segment-${item.id}`}
                          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                        >
                          Jump to segment →
                        </Link>
                      ) : null}
                    </div>
                    <span className="block text-zinc-600 dark:text-zinc-400">
                      {item.text}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {result.followUpSuggestions.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Suggested follow-ups
              </span>
              <ul className="list-inside list-disc text-xs text-zinc-600 dark:text-zinc-400">
                {result.followUpSuggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
