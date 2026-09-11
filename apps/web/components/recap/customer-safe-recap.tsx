"use client";

import { useState } from "react";
import type { CustomerSafeRecap } from "@applywizz/domain/meeting-recap";
import { StatusBadge } from "../admin/status-badge";

interface CustomerSafeRecapSectionProps {
  meetingId: string;
  recap: CustomerSafeRecap;
  canEdit?: boolean;
  onRecapUpdated?: (recap: CustomerSafeRecap) => void;
}

export function CustomerSafeRecapSection({
  meetingId,
  recap: initialRecap,
  canEdit = true,
  onRecapUpdated,
}: CustomerSafeRecapSectionProps) {
  const [recap, setRecap] = useState<CustomerSafeRecap>(initialRecap);
  const [isSaving, setIsSaving] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const isApproved = recap.status === "approved";
  const isReadOnly = isApproved || !canEdit;

  const handleSaveDraft = async (targetStatus: "draft" | "ready_for_review" = "draft") => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const whatWeAgreed = recap.whatWeAgreed ?? recap.agreements ?? [];
      const applyWizzWillDo = recap.applyWizzWillDo ?? recap.actions ?? [];
      const candidateShouldDo =
        recap.candidateShouldDo ?? recap.customerShouldDo ?? [];

      const res = await fetch(`/api/meetings/${meetingId}/recap/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          greeting: recap.greeting,
          whatWeAgreed,
          applyWizzWillDo,
          candidateShouldDo,
          nextStep: recap.nextStep,
          status: targetStatus,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save draft");
      }

      const resData = await res.json();
      const serverRecap = resData.recap || resData;
      const updated: CustomerSafeRecap = {
        ...recap,
        greeting: serverRecap.greeting ?? recap.greeting,
        whatWeAgreed: serverRecap.whatWeAgreed ?? recap.whatWeAgreed,
        applyWizzWillDo: serverRecap.applyWizzWillDo ?? recap.applyWizzWillDo,
        candidateShouldDo:
          serverRecap.candidateShouldDo ?? recap.candidateShouldDo,
        customerShouldDo:
          serverRecap.candidateShouldDo ?? recap.customerShouldDo,
        nextStep: serverRecap.nextStep ?? recap.nextStep,
        status: serverRecap.status ?? targetStatus,
        currentRevisionNumber:
          serverRecap.revisionNumber ?? recap.currentRevisionNumber,
      };
      setRecap(updated);
      setFeedback({
        type: "success",
        message:
          targetStatus === "ready_for_review"
            ? `Marked as ready for review (Revision #${serverRecap.revisionNumber ?? "latest"}).`
            : `Draft saved successfully (Revision #${serverRecap.revisionNumber ?? "latest"}).`,
      });
      onRecapUpdated?.(updated);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Error saving draft",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprove = async () => {
    setIsApproving(true);
    setFeedback(null);
    try {
      const whatWeAgreed = recap.whatWeAgreed ?? recap.agreements ?? [];
      const applyWizzWillDo = recap.applyWizzWillDo ?? recap.actions ?? [];
      const candidateShouldDo =
        recap.candidateShouldDo ?? recap.customerShouldDo ?? [];

      const res = await fetch(`/api/meetings/${meetingId}/recap/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          greeting: recap.greeting,
          whatWeAgreed,
          applyWizzWillDo,
          candidateShouldDo,
          nextStep: recap.nextStep,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to approve recap");
      }

      const resData = await res.json();
      const serverRecap = resData.recap || resData;
      const updated: CustomerSafeRecap = {
        ...recap,
        greeting: serverRecap.greeting ?? recap.greeting,
        whatWeAgreed: serverRecap.whatWeAgreed ?? recap.whatWeAgreed,
        applyWizzWillDo: serverRecap.applyWizzWillDo ?? recap.applyWizzWillDo,
        candidateShouldDo:
          serverRecap.candidateShouldDo ?? recap.candidateShouldDo,
        customerShouldDo:
          serverRecap.candidateShouldDo ?? recap.customerShouldDo,
        nextStep: serverRecap.nextStep ?? recap.nextStep,
        status: "approved",
        approvedAt: serverRecap.approvedAt ?? new Date().toISOString(),
        approvedByMembershipId:
          serverRecap.approvedByMembershipId ?? recap.approvedByMembershipId,
        currentRevisionNumber:
          serverRecap.revisionNumber ?? recap.currentRevisionNumber,
      };
      setRecap(updated);
      setFeedback({
        type: "success",
        message: "Recap approved by Account Manager. Review gate complete.",
      });
      onRecapUpdated?.(updated);
    } catch (err: unknown) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : "Error approving recap",
      });
    } finally {
      setIsApproving(false);
    }
  };

  const updateItem = (
    listKey: "whatWeAgreed" | "applyWizzWillDo" | "candidateShouldDo",
    index: number,
    value: string,
  ) => {
    const list = [
      ...(listKey === "candidateShouldDo"
        ? recap.candidateShouldDo ?? recap.customerShouldDo ?? []
        : recap[listKey] ?? []),
    ];
    list[index] = value;
    if (listKey === "candidateShouldDo") {
      setRecap({ ...recap, candidateShouldDo: list, customerShouldDo: list });
    } else {
      setRecap({ ...recap, [listKey]: list });
    }
  };

  const removeItem = (
    listKey: "whatWeAgreed" | "applyWizzWillDo" | "candidateShouldDo",
    index: number,
  ) => {
    const source =
      listKey === "candidateShouldDo"
        ? recap.candidateShouldDo ?? recap.customerShouldDo ?? []
        : recap[listKey] ?? [];
    const list = source.filter((_, i) => i !== index);
    if (listKey === "candidateShouldDo") {
      setRecap({ ...recap, candidateShouldDo: list, customerShouldDo: list });
    } else {
      setRecap({ ...recap, [listKey]: list });
    }
  };

  const addItem = (
    listKey: "whatWeAgreed" | "applyWizzWillDo" | "candidateShouldDo",
  ) => {
    const source =
      listKey === "candidateShouldDo"
        ? recap.candidateShouldDo ?? recap.customerShouldDo ?? []
        : recap[listKey] ?? [];
    const list = [...source, ""];
    if (listKey === "candidateShouldDo") {
      setRecap({ ...recap, candidateShouldDo: list, customerShouldDo: list });
    } else {
      setRecap({ ...recap, [listKey]: list });
    }
  };

  return (
    <section className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Customer-safe version (AM Review Gate)
          </h2>
          {isApproved ? (
            <StatusBadge tone="success">Approved</StatusBadge>
          ) : recap.status === "ready_for_review" ? (
            <StatusBadge tone="info">Ready for Review</StatusBadge>
          ) : (
            <StatusBadge tone="warning">Draft</StatusBadge>
          )}
          {recap.currentRevisionNumber != null && (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
              Rev #{recap.currentRevisionNumber}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!canEdit ? (
            <div className="text-xs text-zinc-500 italic dark:text-zinc-400">
              Read-only: Only the responsible Account Manager can edit or approve this recap.
            </div>
          ) : !isApproved ? (
            <>
              <button
                type="button"
                onClick={() => handleSaveDraft("draft")}
                disabled={isSaving || isApproving}
                className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {isSaving ? "Saving..." : "Save Draft"}
              </button>

              {recap.status !== "ready_for_review" && (
                <button
                  type="button"
                  onClick={() => handleSaveDraft("ready_for_review")}
                  disabled={isSaving || isApproving}
                  className="rounded-md border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300 dark:hover:bg-indigo-950/70"
                >
                  Mark Ready for Review
                </button>
              )}

              <button
                type="button"
                onClick={handleApprove}
                disabled={isSaving || isApproving}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
              >
                {isApproving ? "Approving..." : "Approve Recap"}
              </button>
            </>
          ) : (
            <div className="text-xs text-emerald-700 font-medium dark:text-emerald-400">
              ✓ Approved on {new Date(recap.approvedAt!).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>

      {feedback && (
        <div
          className={`px-5 py-2.5 text-xs font-medium ${
            feedback.type === "success"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="flex flex-col gap-4 p-5 text-sm">
        <div>
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Greeting / Intro
          </label>
          {isReadOnly ? (
            <p className="mt-1 text-zinc-800 dark:text-zinc-200">
              {recap.greeting}
            </p>
          ) : (
            <input
              type="text"
              value={recap.greeting}
              onChange={(e) => setRecap({ ...recap, greeting: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          )}
        </div>

        <EditableList
          title="What We Agreed"
          items={recap.whatWeAgreed ?? recap.agreements ?? []}
          isReadOnly={isReadOnly}
          onUpdate={(i, val) => updateItem("whatWeAgreed", i, val)}
          onRemove={(i) => removeItem("whatWeAgreed", i)}
          onAdd={() => addItem("whatWeAgreed")}
        />

        <EditableList
          title="What ApplyWizz Will Do"
          items={recap.applyWizzWillDo ?? recap.actions ?? []}
          isReadOnly={isReadOnly}
          onUpdate={(i, val) => updateItem("applyWizzWillDo", i, val)}
          onRemove={(i) => removeItem("applyWizzWillDo", i)}
          onAdd={() => addItem("applyWizzWillDo")}
        />

        <EditableList
          title="What Candidate Should Provide / Do"
          items={recap.candidateShouldDo ?? recap.customerShouldDo ?? []}
          isReadOnly={isReadOnly}
          onUpdate={(i, val) => updateItem("candidateShouldDo", i, val)}
          onRemove={(i) => removeItem("candidateShouldDo", i)}
          onAdd={() => addItem("candidateShouldDo")}
        />

        <div>
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400">
            Next Journey Step
          </label>
          {isReadOnly ? (
            <p className="mt-1 text-zinc-800 dark:text-zinc-200">
              {recap.nextStep}
            </p>
          ) : (
            <input
              type="text"
              value={recap.nextStep}
              onChange={(e) => setRecap({ ...recap, nextStep: e.target.value })}
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          )}
        </div>
      </div>
    </section>
  );
}

function EditableList({
  title,
  items,
  isReadOnly,
  onUpdate,
  onRemove,
  onAdd,
}: {
  title: string;
  items: string[];
  isReadOnly: boolean;
  onUpdate: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold text-zinc-600 dark:text-zinc-400">
          {title}
        </label>
        {!isReadOnly && (
          <button
            type="button"
            onClick={onAdd}
            className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 dark:text-indigo-400"
          >
            + Add item
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="text-xs italic text-zinc-400">No items listed.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item, idx) => (
            <li key={idx} className="flex items-center gap-2">
              {isReadOnly ? (
                <span className="text-zinc-800 dark:text-zinc-200">
                  • {item}
                </span>
              ) : (
                <>
                  <input
                    type="text"
                    value={item}
                    onChange={(e) => onUpdate(idx, e.target.value)}
                    className="flex-1 rounded-md border border-zinc-300 px-2.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <button
                    type="button"
                    onClick={() => onRemove(idx)}
                    className="text-xs text-zinc-400 hover:text-red-600"
                    title="Remove item"
                  >
                    ×
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
