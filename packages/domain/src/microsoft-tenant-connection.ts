import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { getAppOnlyAccessToken } from "@applywizz/microsoft";
import { logAuditEvent } from "./audit";
import type { MicrosoftEnv } from "./microsoft-connection";

export type AppSupabaseClient = SupabaseClient<Database>;

export interface ConnectTenantMicrosoftInput {
  organizationId: string;
  connectedByMembershipId: string;
  actorUserId: string;
  microsoftEnv: MicrosoftEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Turns on tenant-wide (app-only/client-credentials) Microsoft sync for an
 * organization. No OAuth redirect, no per-connection secret to store — the
 * tenant credential IS the server's own MICROSOFT_TENANT_ID/CLIENT_ID/
 * CLIENT_SECRET env vars. `supabase` is the admin's OWN authenticated
 * client (RLS enforces is_org_admin() independently of this function),
 * same pattern as calendar_connections' own connect flow.
 *
 * Verifies the app-only credential actually works BEFORE recording
 * success — no false "Connected" state, matching the delegated flow's own
 * philosophy. This is a bigger blast radius than one person connecting
 * their own account (it reads every eligible employee's calendar without
 * individual consent), so it's always paired with an explicit audit event.
 */
export async function connectTenantMicrosoft(
  supabase: AppSupabaseClient,
  input: ConnectTenantMicrosoftInput,
): Promise<{ tenantConnectionId: string }> {
  await getAppOnlyAccessToken(
    {
      tenantId: input.microsoftEnv.tenantId,
      clientId: input.microsoftEnv.clientId,
      clientSecret: input.microsoftEnv.clientSecret,
    },
    input.fetchImpl,
  );

  const { data, error } = await supabase
    .from("microsoft_tenant_connections")
    .upsert(
      {
        organization_id: input.organizationId,
        provider: "microsoft",
        status: "active",
        connected_by_membership_id: input.connectedByMembershipId,
        connected_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();
  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "microsoft.tenant_sync_enabled",
    entityType: "microsoft_tenant_connection",
    entityId: data.id,
    metadata: { connectedByMembershipId: input.connectedByMembershipId },
  });

  return { tenantConnectionId: data.id };
}

export async function disableTenantMicrosoft(
  supabase: AppSupabaseClient,
  input: { organizationId: string; actorUserId: string },
): Promise<void> {
  const { data, error } = await supabase
    .from("microsoft_tenant_connections")
    .update({ status: "disabled" })
    .eq("organization_id", input.organizationId)
    .eq("provider", "microsoft")
    .select("id")
    .single();
  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "microsoft.tenant_sync_disabled",
    entityType: "microsoft_tenant_connection",
    entityId: data.id,
  });
}

export interface TenantConnectionStatusView {
  status: "not_connected" | "active" | "disabled";
  connectedAt: string | null;
  lastReconciliationResult: unknown | null;
}

export async function getTenantConnectionStatus(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<TenantConnectionStatusView> {
  const { data, error } = await supabase
    .from("microsoft_tenant_connections")
    .select("status, connected_at, last_reconciliation_result")
    .eq("organization_id", organizationId)
    .eq("provider", "microsoft")
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: "not_connected", connectedAt: null, lastReconciliationResult: null };

  return {
    status: data.status as "active" | "disabled",
    connectedAt: data.connected_at,
    lastReconciliationResult: data.last_reconciliation_result,
  };
}
