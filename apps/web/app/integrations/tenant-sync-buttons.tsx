"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function EnableTenantSyncButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable() {
    if (
      !window.confirm(
        "Enable organization-wide Microsoft sync? Signal will read the calendar of every eligible employee (Meeting Intelligence on) without them individually connecting.",
      )
    )
      return;
    setPending(true);
    setError(null);
    const response = await fetch("/api/integrations/microsoft/tenant/connect", { method: "POST" });
    setPending(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not enable tenant-wide sync.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={handleEnable}
        disabled={pending}
        className="w-fit rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
      >
        {pending ? "Enabling…" : "Enable organization-wide sync"}
      </button>
      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </div>
  );
}

export function DisableTenantSyncButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleDisable() {
    if (!window.confirm("Disable organization-wide Microsoft sync?")) return;
    setPending(true);
    await fetch("/api/integrations/microsoft/tenant/disable", { method: "POST" });
    setPending(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleDisable}
      disabled={pending}
      className="w-fit rounded-md border border-red-300 px-3 py-2 text-sm font-medium text-red-700 disabled:opacity-50"
    >
      {pending ? "Disabling…" : "Disable"}
    </button>
  );
}
