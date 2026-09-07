import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";

type AppSupabaseClient = SupabaseClient<Database>;

export interface AuditEventInput {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Application-level audit events (Microsoft connection lifecycle, and
 * anything else that isn't a simple column diff on one row the way M2's
 * membership-change trigger is). Normally writes through the caller's own
 * authenticated client — audit_events_insert_own_org (M3 RLS migration)
 * scopes it to their own organization, same as every other write in this
 * app. As of M5, service_role also has a narrow INSERT-only grant (no
 * SELECT/UPDATE/DELETE) for genuinely system-triggered events with no
 * authenticated human actor — e.g. cutoff/default resolution — pass
 * `actorId: null` for those. Never log tokens/secrets in metadata.
 */
export async function logAuditEvent(
  supabase: AppSupabaseClient,
  input: AuditEventInput,
): Promise<void> {
  const { error } = await supabase.from("audit_events").insert({
    organization_id: input.organizationId,
    actor_id: input.actorId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    metadata: (input.metadata ?? {}) as Json,
  });
  if (error) throw error;
}
