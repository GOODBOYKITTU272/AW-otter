"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export interface CustomerTabDef {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
}

export function CustomerDetailTabs({
  tabs,
  defaultTab = "overview",
}: {
  tabs: CustomerTabDef[];
  defaultTab?: string;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const requestedTab = searchParams.get("tab");

  const [localTab, setLocalTab] = useState(defaultTab);
  const active =
    requestedTab && tabs.some((t) => t.key === requestedTab)
      ? requestedTab
      : localTab;

  function switchTab(key: string) {
    setLocalTab(key);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", key);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex border-b border-zinc-200 dark:border-zinc-800" role="tablist">
        {tabs.map((tab) => {
          const isSelected = active === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => switchTab(tab.key)}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                isSelected
                  ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
                  : "border-transparent text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              }`}
            >
              {tab.label}
              {typeof tab.count === "number" && tab.count > 0 ? (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    isSelected
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900/60 dark:text-blue-300"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  }`}
                >
                  {tab.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div key={tab.key} hidden={active !== tab.key} role="tabpanel">
          {tab.content}
        </div>
      ))}
    </div>
  );
}
