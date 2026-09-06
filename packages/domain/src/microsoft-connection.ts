import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import {
  MICROSOFT_SCOPES,
  INITIAL_SYNC_WINDOW_DAYS,
  createSubscription,
  decodeIdentityFromIdToken,
  decryptToken,
  deleteSubscription,
  encryptToken,
  exchangeCodeForTokens,
  isTeamsEvent,
  listUpcomingEvents,
  refreshAccessToken,
  renewSubscription,
} from "@applywizz/microsoft";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Supabase/Postgrest errors are plain objects, not Error instances — a bare
 * `String(error)` on one gives the useless "[object Object]". Extract
 * `.message` wherever it exists instead.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export interface MicrosoftEnv {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  webhookClientState: string;
}

export interface CompleteMicrosoftConnectionInput {
  organizationId: string;
  membershipId: string;
  actorUserId: string;
  code: string;
  redirectUri: string;
  webhookUrl: string;
  microsoftEnv: MicrosoftEnv;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
}

export interface CompleteMicrosoftConnectionResult {
  connectionId: string;
  eventsRead: number;
  teamsEventsDetected: number;
  subscriptionCreated: boolean;
  initialSyncSucceeded: boolean;
  warnings: string[];
}

/**
 * The OAuth callback's orchestration: exchange code -> identity -> persist
 * connection -> encrypted tokens -> Graph subscription -> bounded initial
 * read. `supabase` is the connecting user's OWN authenticated client (RLS
 * enforces organization_membership_id = their own membership independently
 * of this function); `serviceRoleClient` touches ONLY
 * calendar_connection_secrets, which no authenticated/anon role can reach
 * at all (see 20260906020013_microsoft_integration_rls.sql).
 *
 * Subscription creation and the initial read are best-effort past this
 * point: a real connection now exists (tokens exchanged, identity
 * verified), so a later failure is reported as a warning, not undone —
 * "no false Connected state" means the OAuth result itself must be
 * genuine, not that every downstream step must succeed atomically.
 */
export async function completeMicrosoftConnection(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: CompleteMicrosoftConnectionInput,
): Promise<CompleteMicrosoftConnectionResult> {
  const tokens = await exchangeCodeForTokens(
    {
      tenantId: input.microsoftEnv.tenantId,
      clientId: input.microsoftEnv.clientId,
      clientSecret: input.microsoftEnv.clientSecret,
      redirectUri: input.redirectUri,
      code: input.code,
    },
    input.fetchImpl,
  );

  if (!tokens.idToken) throw new Error("Microsoft did not return an ID token.");
  const identity = decodeIdentityFromIdToken(tokens.idToken);

  const { data: connection, error: connectionError } = await supabase
    .from("calendar_connections")
    .upsert(
      {
        organization_membership_id: input.membershipId,
        provider: "microsoft",
        provider_user_id: identity.providerUserId,
        status: "active",
        scope_metadata: {
          email: identity.email,
          displayName: identity.displayName,
          scopes: [...MICROSOFT_SCOPES],
        },
      },
      { onConflict: "organization_membership_id,provider" },
    )
    .select()
    .single();
  if (connectionError) throw connectionError;

  const { error: secretsError } = await serviceRoleClient
    .from("calendar_connection_secrets")
    .upsert({
      connection_id: connection.id,
      encrypted_access_token: encryptToken(
        tokens.accessToken,
        input.encryptionKey,
      ),
      encrypted_refresh_token: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, input.encryptionKey)
        : null,
      access_token_expires_at: tokens.expiresAt,
    });
  if (secretsError) throw secretsError;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "microsoft.connected",
    entityType: "calendar_connection",
    entityId: connection.id,
    metadata: { providerUserId: identity.providerUserId },
  });

  const warnings: string[] = [];
  let subscriptionCreated = false;
  let eventsRead = 0;
  let teamsEventsDetected = 0;
  let initialSyncSucceeded = false;

  try {
    const subscriptionDto = await createSubscription({
      accessToken: tokens.accessToken,
      notificationUrl: input.webhookUrl,
      clientState: input.microsoftEnv.webhookClientState,
      fetchImpl: input.fetchImpl,
    });

    const { data: subscriptionRow, error: subError } = await supabase
      .from("provider_subscriptions")
      .insert({
        calendar_connection_id: connection.id,
        provider: "microsoft",
        external_subscription_id: subscriptionDto.externalSubscriptionId,
        resource: subscriptionDto.resource,
        expires_at: subscriptionDto.expiresAt,
        status: "active",
      })
      .select()
      .single();
    if (subError) throw subError;

    subscriptionCreated = true;
    await logAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      action: "microsoft.subscription_created",
      entityType: "provider_subscription",
      // Our own row's id, not Microsoft's subscription id — entity_id is a
      // uuid column referencing our own tables, not an external identifier.
      entityId: subscriptionRow.id,
      metadata: {
        externalSubscriptionId: subscriptionDto.externalSubscriptionId,
      },
    });
  } catch (error) {
    const message = errorMessage(error);
    warnings.push(`Could not create a calendar subscription: ${message}`);
    await logAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      action: "microsoft.subscription_failed",
      entityType: "calendar_connection",
      entityId: connection.id,
      metadata: { error: message },
    });
  }

  try {
    const events = await listUpcomingEvents(
      tokens.accessToken,
      input.fetchImpl,
    );
    eventsRead = events.length;
    teamsEventsDetected = events.filter(isTeamsEvent).length;

    const now = new Date();
    const windowEnd = new Date(
      now.getTime() + INITIAL_SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const { error: cursorError } = await supabase
      .from("calendar_sync_cursors")
      .upsert(
        {
          calendar_connection_id: connection.id,
          window_start: now.toISOString(),
          window_end: windowEnd.toISOString(),
        },
        { onConflict: "calendar_connection_id" },
      );
    if (cursorError) throw cursorError;

    const { error: updateError } = await supabase
      .from("calendar_connections")
      .update({ last_sync_at: now.toISOString() })
      .eq("id", connection.id);
    if (updateError) throw updateError;

    initialSyncSucceeded = true;
    await logAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      action: "microsoft.initial_sync_succeeded",
      entityType: "calendar_connection",
      entityId: connection.id,
      metadata: { eventsRead, teamsEventsDetected },
    });
  } catch (error) {
    const message = errorMessage(error);
    warnings.push(`Initial calendar read failed: ${message}`);
    await logAuditEvent(supabase, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      action: "microsoft.initial_sync_failed",
      entityType: "calendar_connection",
      entityId: connection.id,
      metadata: { error: message },
    });
  }

  return {
    connectionId: connection.id,
    eventsRead,
    teamsEventsDetected,
    subscriptionCreated,
    initialSyncSucceeded,
    warnings,
  };
}

/** Decrypts the stored access token, transparently refreshing it first if it's near expiry. */
export async function getValidAccessToken(
  serviceRoleClient: AppSupabaseClient,
  connectionId: string,
  microsoftEnv: MicrosoftEnv,
  encryptionKey: string,
  fetchImpl?: typeof fetch,
): Promise<string> {
  const { data: secret, error } = await serviceRoleClient
    .from("calendar_connection_secrets")
    .select("*")
    .eq("connection_id", connectionId)
    .single();
  if (error) throw error;

  const expiresAt = new Date(secret.access_token_expires_at).getTime();
  const fiveMinutesMs = 5 * 60 * 1000;
  if (expiresAt - Date.now() > fiveMinutesMs) {
    return decryptToken(secret.encrypted_access_token, encryptionKey);
  }

  if (!secret.encrypted_refresh_token) {
    throw new Error(
      "Microsoft access token expired and no refresh token is stored.",
    );
  }

  const refreshToken = decryptToken(
    secret.encrypted_refresh_token,
    encryptionKey,
  );
  const tokens = await refreshAccessToken(
    {
      tenantId: microsoftEnv.tenantId,
      clientId: microsoftEnv.clientId,
      clientSecret: microsoftEnv.clientSecret,
      refreshToken,
    },
    fetchImpl,
  );

  const { error: updateError } = await serviceRoleClient
    .from("calendar_connection_secrets")
    .update({
      encrypted_access_token: encryptToken(tokens.accessToken, encryptionKey),
      encrypted_refresh_token: tokens.refreshToken
        ? encryptToken(tokens.refreshToken, encryptionKey)
        : secret.encrypted_refresh_token,
      access_token_expires_at: tokens.expiresAt,
    })
    .eq("connection_id", connectionId);
  if (updateError) throw updateError;

  return tokens.accessToken;
}

/** Not scheduled in M3 (that's an M16 reliability concern) — callable on demand. */
export async function renewMicrosoftSubscription(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  subscriptionId: string,
  microsoftEnv: MicrosoftEnv,
  encryptionKey: string,
  fetchImpl?: typeof fetch,
): Promise<void> {
  const { data: subscription, error } = await supabase
    .from("provider_subscriptions")
    .select("*")
    .eq("id", subscriptionId)
    .single();
  if (error) throw error;

  const accessToken = await getValidAccessToken(
    serviceRoleClient,
    subscription.calendar_connection_id,
    microsoftEnv,
    encryptionKey,
    fetchImpl,
  );
  const renewed = await renewSubscription(
    accessToken,
    subscription.external_subscription_id,
    fetchImpl,
  );

  const { error: updateError } = await supabase
    .from("provider_subscriptions")
    .update({
      expires_at: renewed.expiresAt,
      last_renewed_at: new Date().toISOString(),
      status: "active",
    })
    .eq("id", subscriptionId);
  if (updateError) throw updateError;
}

export interface DisconnectMicrosoftConnectionInput {
  organizationId: string;
  actorUserId: string;
  connectionId: string;
  microsoftEnv: MicrosoftEnv;
  encryptionKey: string;
  fetchImpl?: typeof fetch;
}

export async function disconnectMicrosoftConnection(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: DisconnectMicrosoftConnectionInput,
): Promise<void> {
  const { data: subscriptions } = await supabase
    .from("provider_subscriptions")
    .select("id, external_subscription_id")
    .eq("calendar_connection_id", input.connectionId)
    .eq("status", "active");

  for (const subscription of subscriptions ?? []) {
    try {
      const accessToken = await getValidAccessToken(
        serviceRoleClient,
        input.connectionId,
        input.microsoftEnv,
        input.encryptionKey,
        input.fetchImpl,
      );
      await deleteSubscription(
        accessToken,
        subscription.external_subscription_id,
        input.fetchImpl,
      );
    } catch {
      // Best-effort: the local disconnect must still proceed even if the
      // remote Graph subscription can't be torn down (e.g. token already
      // invalid). Graph subscriptions expire on their own regardless.
    }
    await supabase
      .from("provider_subscriptions")
      .update({ status: "cancelled" })
      .eq("id", subscription.id);
  }

  const { error } = await supabase
    .from("calendar_connections")
    .update({ status: "disconnected" })
    .eq("id", input.connectionId);
  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "microsoft.disconnected",
    entityType: "calendar_connection",
    entityId: input.connectionId,
  });
}

export interface ConnectionStatusView {
  status: "not_connected" | "pending" | "active" | "error" | "disconnected";
  providerEmail: string | null;
  lastSyncAt: string | null;
  subscription: { status: string; expiresAt: string } | null;
}

export async function getConnectionStatus(
  supabase: AppSupabaseClient,
  membershipId: string,
): Promise<ConnectionStatusView> {
  const { data: connection, error } = await supabase
    .from("calendar_connections")
    .select("*")
    .eq("organization_membership_id", membershipId)
    .eq("provider", "microsoft")
    .maybeSingle();
  if (error) throw error;
  if (!connection) {
    return {
      status: "not_connected",
      providerEmail: null,
      lastSyncAt: null,
      subscription: null,
    };
  }

  const { data: subscription } = await supabase
    .from("provider_subscriptions")
    .select("status, expires_at")
    .eq("calendar_connection_id", connection.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const metadata = connection.scope_metadata as { email?: string } | null;

  return {
    status: connection.status as ConnectionStatusView["status"],
    providerEmail: metadata?.email ?? null,
    lastSyncAt: connection.last_sync_at,
    subscription: subscription
      ? { status: subscription.status, expiresAt: subscription.expires_at }
      : null,
  };
}
