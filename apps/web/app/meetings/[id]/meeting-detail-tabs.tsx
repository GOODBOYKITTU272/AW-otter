"use client";

import { useState, type ReactNode } from "react";
import styles from "./meeting-detail.module.css";

interface TabDef {
  key: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/**
 * All five panels are fetched server-side and passed in already-rendered —
 * this component only switches which one is visible. No client-side data
 * fetching, matching this codebase's server-component-first convention.
 */
export function MeetingDetailTabs({ tabs }: { tabs: TabDef[] }) {
  const [active, setActive] = useState(tabs[0]?.key);

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
            onClick={() => setActive(tab.key)}
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
