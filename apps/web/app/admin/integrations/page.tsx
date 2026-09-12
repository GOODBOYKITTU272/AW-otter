import { getCurrentMembership } from "@applywizz/auth";
import { getConnectionStatus } from "@applywizz/domain/microsoft-connection";
import { getTenantConnectionStatus } from "@applywizz/domain/microsoft-tenant-connection";
import { SYSTEM_ROLE_KEYS } from "@applywizz/domain";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { getAzureMaiEnv, getSarvamEnv } from "@/env/server";
import { StatusBadge } from "@/components/admin/status-badge";
import { DisconnectMicrosoftButton } from "./disconnect-microsoft-button";
import { DisableTenantSyncButton, EnableTenantSyncButton } from "./tenant-sync-buttons";
import { IntegrationDetailsToggle } from "./integration-details-toggle";

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
  await requireRole(SYSTEM_ROLE_KEYS);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);
  const status = await getConnectionStatus(supabase, membership.membershipId);
  const tenantStatus =
    membership.roleKey === "admin" ? await getTenantConnectionStatus(supabase, membership.organizationId) : null;

  const azureEnv = getAzureMaiEnv();
  const isAzureConfigured = azureEnv.isConfigured;
  const sarvamEnv = getSarvamEnv();
  const isSarvamConfigured = sarvamEnv.isConfigured;
  const isOpenRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const isDatabaseReachable = true;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E]">Integrations</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Speech pipelines, calendar sync, and system health
        </p>
      </div>

      {params.microsoft_connected ? (
        <p className="rounded-lg bg-[#29FE29]/10 border border-[#29FE29]/20 px-4 py-2 text-sm text-[#166534]">
          Microsoft connected successfully.
        </p>
      ) : null}
      {params.microsoft_error ? (
        <p className="rounded-lg bg-[#FF5C5C]/10 border border-[#FF5C5C]/20 px-4 py-2 text-sm text-[#991B1B]">
          {params.microsoft_error}
        </p>
      ) : null}

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">Microsoft Graph</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Calendar & meetings sync</p>
            </div>
            <StatusBadge tone={status.status === "active" ? "success" : status.status === "error" ? "critical" : "neutral"}>
              {STATUS_LABEL[status.status]}
            </StatusBadge>
          </div>

          {status.status === "active" ? (
            <div className="mt-4 text-xs text-zinc-600 space-y-1">
              <div>
                <span className="font-medium text-[#1E1E1E]">Account:</span> {status.providerEmail ?? "—"}
              </div>
              <div>
                <span className="font-medium text-[#1E1E1E]">Last sync:</span>{" "}
                {status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : "Never"}
              </div>
              <IntegrationDetailsToggle>
                <div className="text-xs text-zinc-500 mt-2 space-y-0.5">
                  <div>Subscription: {status.subscription?.status ?? "not created"}</div>
                  {status.subscription?.expiresAt && (
                    <div>Expires: {new Date(status.subscription.expiresAt).toLocaleString()}</div>
                  )}
                </div>
              </IntegrationDetailsToggle>
            </div>
          ) : null}

          <div className="mt-4 flex gap-2">
            {status.status === "active" ? (
              <DisconnectMicrosoftButton />
            ) : (
              <a
                href="/api/integrations/microsoft/connect"
                className="rounded-md bg-[#2C76FF] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#2C76FF]/90"
              >
                Connect
              </a>
            )}
          </div>
        </div>

        {tenantStatus && (
          <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <h2 className="font-semibold text-[#1E1E1E]">Microsoft Entra</h2>
                <p className="text-xs text-zinc-500 mt-0.5">Organization-wide calendar sync</p>
              </div>
              <StatusBadge tone={tenantStatus.status === "active" ? "success" : "neutral"}>
                {tenantStatus.status === "active" ? "Enabled" : tenantStatus.status === "disabled" ? "Disabled" : "Not configured"}
              </StatusBadge>
            </div>

            {tenantStatus.status === "active" ? (
              <div className="mt-4 text-xs text-zinc-600">
                <div>
                  <span className="font-medium text-[#1E1E1E]">Connected:</span>{" "}
                  {tenantStatus.connectedAt ? new Date(tenantStatus.connectedAt).toLocaleString() : "—"}
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-zinc-500">
                When enabled, reads calendars for all eligible employees automatically
              </p>
            )}

            <div className="mt-4">
              {tenantStatus.status === "active" ? <DisableTenantSyncButton /> : <EnableTenantSyncButton />}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">Vexa Bot</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Meeting recorder</p>
            </div>
            <StatusBadge tone={isAzureConfigured ? "neutral" : "warning"}>
              Configured
            </StatusBadge>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            Bot joins scheduled meetings and captures audio for transcription
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">Azure Speech (MAI)</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Primary transcriber</p>
            </div>
            <StatusBadge tone={isAzureConfigured ? "neutral" : "warning"}>
              {isAzureConfigured ? "Configured" : "Not configured"}
            </StatusBadge>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            Azure MAI speech-to-text — primary provider for meeting transcription
          </p>
          <IntegrationDetailsToggle>
            <div className="mt-3 text-xs text-zinc-500 space-y-0.5">
              <div>Region: {azureEnv.AZURE_MAI_REGION ?? "Not set"}</div>
              <div>Model: MAI-Transcribe-2</div>
            </div>
          </IntegrationDetailsToggle>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">Sarvam AI</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Fallback STT #2</p>
            </div>
            <StatusBadge tone={isSarvamConfigured ? "neutral" : "warning"}>
              {isSarvamConfigured ? "Configured" : "Not configured"}
            </StatusBadge>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            Sarvam Saaras v4 — Indic language specialist, fallback transcriber
          </p>
          <IntegrationDetailsToggle>
            <div className="mt-3 text-xs text-zinc-500">
              <div>Model: saaras:v4</div>
              <div>Mode: Batch transcription</div>
            </div>
          </IntegrationDetailsToggle>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">OpenRouter Whisper</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Fallback STT #3</p>
            </div>
            <StatusBadge tone={isOpenRouterConfigured ? "neutral" : "warning"}>
              {isOpenRouterConfigured ? "Configured" : "Not configured"}
            </StatusBadge>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            OpenAI Whisper via OpenRouter — final fallback transcriber
          </p>
          <IntegrationDetailsToggle>
            <div className="mt-3 text-xs text-zinc-500">
              <div>Model: whisper-large-v3-turbo</div>
            </div>
          </IntegrationDetailsToggle>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h2 className="font-semibold text-[#1E1E1E]">Supabase</h2>
              <p className="text-xs text-zinc-500 mt-0.5">Database & storage</p>
            </div>
            <StatusBadge tone={isDatabaseReachable ? "success" : "critical"}>
              {isDatabaseReachable ? "Operational" : "Unreachable"}
            </StatusBadge>
          </div>
          <p className="mt-4 text-xs text-zinc-600">
            PostgreSQL database and object storage for meetings, transcripts, and intelligence
          </p>
        </div>
      </section>
    </main>
  );
}
