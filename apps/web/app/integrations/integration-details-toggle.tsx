"use client";

import { useState } from "react";

export function IntegrationDetailsToggle({ children }: { children: React.ReactNode }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setShowDetails(!showDetails)}
        className="text-xs text-[#2C76FF] hover:underline font-medium"
      >
        {showDetails ? "Hide details" : "Show details"}
      </button>
      {showDetails && <div className="mt-2">{children}</div>}
    </div>
  );
}
