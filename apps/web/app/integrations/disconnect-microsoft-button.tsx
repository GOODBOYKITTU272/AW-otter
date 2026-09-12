"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DisconnectMicrosoftButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleDisconnect() {
    if (
      !window.confirm(
        "Disconnect Microsoft? Calendar sync stops until reconnected.",
      )
    )
      return;
    setPending(true);
    await fetch("/api/integrations/microsoft/disconnect", { method: "POST" });
    setPending(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleDisconnect}
      disabled={pending}
      className="rounded-md bg-[#FF5C5C] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#FF5C5C]/90 disabled:opacity-50"
    >
      {pending ? "Disconnecting…" : "Disconnect"}
    </button>
  );
}
