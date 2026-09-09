"use client";

import { useState } from "react";
import type { AskSignalResult } from "@applywizz/ai";

const ANSWERABILITY_LABEL: Record<AskSignalResult["answerability"], string> = {
  answered: "Answered",
  partially_answered: "Partially answered",
  insufficient_evidence: "Insufficient evidence",
};

// M13 vertical slice UI: a single question box, the answer, and its
// evidence — no chatbot personality, no conversation history, no
// follow-up thread. Every rendered evidence excerpt is exactly what the
// route returned (already server-hydrated from the original bundle,
// never anything the model wrote) — this component never re-derives or
// re-displays model-authored text as if it were a quote.
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
          <span className="w-fit rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {ANSWERABILITY_LABEL[result.answerability]}
          </span>
          <p className="text-sm text-zinc-900 dark:text-zinc-100">
            {result.answer}
          </p>
          {result.unresolvedAmbiguity ? (
            <p className="text-sm italic text-zinc-500 dark:text-zinc-400">
              {result.unresolvedAmbiguity}
            </p>
          ) : null}
          {result.evidence.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Evidence
              </span>
              <ul className="flex flex-col gap-1">
                {result.evidence.map((item) => (
                  <li
                    key={`${item.type}:${item.id}`}
                    className="rounded-md bg-zinc-50 p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                  >
                    <span className="font-medium">{item.label}</span>
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
