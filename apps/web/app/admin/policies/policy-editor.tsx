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

      <section className="flex max-w-md flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-5 text-sm shadow-sm">
        <h2 className="font-medium text-[#1E1E1E]">Organization default</h2>
        <p className="text-zinc-600">
          Applied when no other rule fires — including any do-not-record request left unresolved
          at cutoff.
        </p>

        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Default decision
          <select
            value={defaultDecision}
            onChange={(event) => setDefaultDecision(event.target.value)}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[#1E1E1E]"
          >
            <option value="record">Record</option>
            <option value="exclude">Do not record</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Cutoff (minutes before meeting start)
          <input
            type="number"
            min={0}
            value={cutoffMinutes}
            onChange={(event) => setCutoffMinutes(Number(event.target.value))}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-[#1E1E1E]"
          />
          <span className="text-xs text-zinc-500">
            An unresolved do-not-record request still pending this many minutes before the meeting
            starts automatically follows the default above.
          </span>
        </label>

        <button
          type="button"
          onClick={saveSet}
          disabled={savingSet}
          className="w-fit rounded-md bg-[#2C76FF] px-4 py-2 font-medium text-white hover:bg-[#2C76FF]/90 disabled:opacity-50"
        >
          {savingSet ? "Saving…" : "Save"}
        </button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-[#1E1E1E]">Eligibility rules</h2>
        <p className="text-sm text-zinc-600">
          Evaluated in a fixed order, top to bottom — the first enabled rule that applies decides
          the meeting.
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50">
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Rule</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Reason code</th>
                <th className="px-4 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rules.map((rule) => {
                const inert = INERT_RULE_TYPES.has(rule.rule_type);
                return (
                  <tr key={rule.id} className="hover:bg-zinc-50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#1E1E1E]">{rule.label}</div>
                      {inert ? (
                        <div className="text-xs text-zinc-500">Not active in this release</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-zinc-600">{rule.reason_code}</td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={inert || ruleSaving === rule.rule_type}
                        onChange={(event) => toggleRule(rule.rule_type, event.target.checked)}
                        className="h-4 w-4"
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
