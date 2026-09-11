"use client";

import { useState, useEffect, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./meeting-detail.module.css";

interface TabDef {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/**
 * All panels are fetched server-side and passed in already-rendered.
 * This component switches which one is visible and supports deep linking
 * to ?tab=transcript and #segment-[id].
 */
export function MeetingDetailTabs({ tabs }: { tabs: TabDef[] }) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");

  const [localTab, setLocalTab] = useState<string>(
    () => tabs[0]?.key ?? "summary",
  );

  const active =
    requestedTab && tabs.some((t) => t.key === requestedTab)
      ? requestedTab
      : localTab;

  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash.startsWith("#segment-")) {
        setLocalTab("transcript");
        const targetId = window.location.hash.slice(1);
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    };

    window.addEventListener("hashchange", handleHash);
    if (window.location.hash.startsWith("#segment-")) {
      window.requestAnimationFrame(handleHash);
    }
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    if (
      active === "transcript" &&
      typeof window !== "undefined" &&
      window.location.hash.startsWith("#segment-")
    ) {
      const targetId = window.location.hash.slice(1);
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [active]);

  return (
    <div>
      <div className={styles.tabBar} role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            className={`${styles.tab} ${active === tab.key ? styles.tabActive : ""}`}
            onClick={() => setLocalTab(tab.key)}
          >
            {tab.label}
            {typeof tab.count === "number" && tab.count > 0 ? (
              <span className={styles.tabCount}>{tab.count}</span>
            ) : null}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.key} hidden={active !== tab.key} role="tabpanel">
          {tab.content}
        </div>
      ))}
    </div>
  );
}

