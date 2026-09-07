"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type PolicySet = {
  id: string;
  name: string;
  default_decision: string;
  cutoff_minutes_before_start: number;
};

type Rule = {
  id: string;
  rule_type: string;
  enabled: boolean;
  reason_code: string;
  label: string;
};

// These three are seeded for schema completeness / future milestones but
// evaluateMeetingPolicy never actually checks them yet (see its own doc
// comment) — shown, not hidden, but not editable, so the UI never implies
// a toggle does something it doesn't.
const INERT_RULE_TYPES = new Set(["admin_exclusion", "role_team", "org_default"]);

export function PolicyEditor({ policySet, rules }: { policySet: PolicySet; rules: Rule[] }) {
  const router = useRouter();
  const [defaultDecision, setDefaultDecision] = useState(policySet.default_decision);
  const [cutoffMinutes, setCutoffMinutes] = useState(policySet.cutoff_minutes_before_start);
  const [savingSet, setSavingSet] = useState(false);
  const [ruleSaving, setRuleSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function saveSet() {
    setSavingSet(true);
    setError(null);
    const response = await fetch("/api/meeting-policy/set", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        policySetId: policySet.id,
        defaultDecision,
        cutoffMinutesBeforeStart: cutoffMinutes,
      }),
    });
    setSavingSet(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not save.");
      return;
    }
    router.refresh();
  }

  async function toggleRule(ruleType: string, enabled: boolean) {
    setRuleSaving(ruleType);
    setError(null);
    const response = await fetch("/api/meeting-policy/rules", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policySetId: policySet.id, ruleType, enabled }),
    });
    setRuleSaving(null);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not save.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}

      <section className="flex max-w-md flex-col gap-4 rounded-lg border border-zinc-200 p-5 text-sm dark:border-zinc-800">
        <h2 className="font-medium">Organization default</h2>
        <p className="text-zinc-500 dark:text-zinc-400">
          Applied when no other rule fires — including any do-not-record request left unresolved
          at cutoff.
        </p>

        <label className="flex flex-col gap-1">
          Default decision
          <select
            value={defaultDecision}
            onChange={(event) => setDefaultDecision(event.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="record">Record</option>
            <option value="exclude">Do not record</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          Cutoff (minutes before meeting start)
          <input
            type="number"
            min={0}
            value={cutoffMinutes}
            onChange={(event) => setCutoffMinutes(Number(event.target.value))}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            An unresolved do-not-record request still pending this many minutes before the meeting
            starts automatically follows the default above.
          </span>
        </label>

        <button
          type="button"
          onClick={saveSet}
          disabled={savingSet}
          className="w-fit rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {savingSet ? "Saving…" : "Save"}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Eligibility rules</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Evaluated in a fixed order, top to bottom — the first enabled rule that applies decides
          the meeting.
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Rule</th>
                <th className="px-4 py-2.5">Reason code</th>
                <th className="px-4 py-2.5">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => {
                const inert = INERT_RULE_TYPES.has(rule.rule_type);
                return (
                  <tr key={rule.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{rule.label}</div>
                      {inert ? (
                        <div className="text-xs text-zinc-400">Not active in this release</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{rule.reason_code}</td>
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={inert || ruleSaving === rule.rule_type}
                        onChange={(event) => toggleRule(rule.rule_type, event.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
