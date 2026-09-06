import { getCurrentMembership } from "@applywizz/auth";
import { getConnectionStatus } from "@applywizz/domain/microsoft-connection";
import { SYSTEM_ROLE_KEYS } from "@applywizz/domain";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { DisconnectMicrosoftButton } from "./disconnect-microsoft-button";

const STATUS_LABEL: Record<string, string> = {
  not_connected: "Not Connected",
  pending: "Pending",
  active: "Connected",
  error: "Error",
  disconnected: "Not Connected",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  // Any authenticated, active member manages their OWN Microsoft
  // connection here — this is self-service, not an admin capability.
  await requireRole(SYSTEM_ROLE_KEYS);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);
  const status = await getConnectionStatus(supabase, membership.membershipId);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>

      {params.microsoft_connected ? (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-200">
          Microsoft connected successfully.
        </p>
      ) : null}
      {params.microsoft_error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {params.microsoft_error}
        </p>
      ) : null}

      <section className="max-w-lg rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Microsoft</h2>
          <span className="text-sm">{STATUS_LABEL[status.status]}</span>
        </div>

        {status.status === "active" ? (
          <dl className="mt-3 flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
            {status.providerEmail ? (
              <div>
                <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">
                  Account:{" "}
                </dt>
                <dd className="inline">{status.providerEmail}</dd>
              </div>
            ) : null}
            <div>
              <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">
                Last sync:{" "}
              </dt>
              <dd className="inline">
                {status.lastSyncAt
                  ? new Date(status.lastSyncAt).toLocaleString()
                  : "Never"}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-zinc-700 dark:text-zinc-300">
                Subscription:{" "}
              </dt>
              <dd className="inline">
                {status.subscription
                  ? `${status.subscription.status} · expires ${new Date(status.subscription.expiresAt).toLocaleString()}`
                  : "not created"}
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="mt-4 flex gap-3">
          {status.status === "active" ? (
            <DisconnectMicrosoftButton />
          ) : (
            <a
              href="/api/integrations/microsoft/connect"
              className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white dark:bg-zinc-50 dark:text-zinc-900"
            >
              Connect Microsoft
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
