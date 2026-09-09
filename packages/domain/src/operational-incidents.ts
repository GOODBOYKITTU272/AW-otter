import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

export type IncidentSeverity = "warning" | "critical";

export interface RecordIncidentInput {
  organizationId: string;
  queue: string;
  entityId: string;
  incidentType: string;
  severity: IncidentSeverity;
  // Short, coded text only — never transcript/CRM content. Callers are
  // the only enforcement point for this (the column itself is plain
  // text), so every call site in this codebase must pass a fixed,
  // reviewed string, never anything derived from provider/customer data.
  reason: string;
  meetingId?: string | null;
}

/**
 * M16 Slice B: the actual dedup mechanism. One OPEN incident per
 * (organization, queue, entity, type) — enforced by a partial unique
 * index (operational_incidents_open_dedup_uq, `where resolved_at is
 * null`). The whole insert-or-bump decision happens in ONE atomic
 * statement server-side (public.record_operational_incident — `insert
 * ... on conflict ... do update set occurrence_count =
 * occurrence_count + 1`), not as a client-side "select existing, then
 * write existing+1" — that shape lost increments under real concurrency
 * (two callers reading the same stale occurrence_count). See the
 * migration's own comment for why this needs to be a SECURITY DEFINER
 * RPC (service_role already has direct table grants, so this isn't a
 * privilege escalation — it's the only way to get a server-computed
 * increment through the JS client, which cannot send raw SQL
 * expressions).
 */
export async function recordIncident(
  serviceRoleClient: AppSupabaseClient,
  input: RecordIncidentInput,
): Promise<void> {
  const { error } = await serviceRoleClient.rpc("record_operational_incident", {
    p_organization_id: input.organizationId,
    p_queue: input.queue,
    p_entity_id: input.entityId,
    p_incident_type: input.incidentType,
    p_severity: input.severity,
    p_reason: input.reason,
    p_meeting_id: input.meetingId ?? undefined,
  });
  if (error) throw error;
}

export interface ResolveIncidentInput {
  organizationId: string;
  queue: string;
  entityId: string;
}

/** Marks every open incident for this (org, queue, entity) resolved — the next recordIncident call for the same key then creates a genuinely new row (a fresh alert), never reopens the old one. */
export async function resolveIncident(
  serviceRoleClient: AppSupabaseClient,
  input: ResolveIncidentInput,
): Promise<void> {
  const { error } = await serviceRoleClient
    .from("operational_incidents")
    .update({ resolved_at: new Date().toISOString() })
    .eq("organization_id", input.organizationId)
    .eq("queue", input.queue)
    .eq("entity_id", input.entityId)
    .is("resolved_at", null);
  if (error) throw error;
}

export interface OpenIncident {
  id: string;
  queue: string;
  entityId: string;
  incidentType: string;
  severity: IncidentSeverity;
  reason: string;
  meetingId: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Read path — RLS-scoped via the caller's own client, admin-only (operational_incidents_select_admin_org), never service_role. */
export async function listOpenIncidents(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<OpenIncident[]> {
  const { data, error } = await supabase
    .from("operational_incidents")
    .select(
      "id, queue, entity_id, incident_type, severity, reason, meeting_id, occurrence_count, first_seen_at, last_seen_at",
    )
    .eq("organization_id", organizationId)
    .is("resolved_at", null)
    .order("last_seen_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    queue: r.queue,
    entityId: r.entity_id,
    incidentType: r.incident_type,
    severity: r.severity as IncidentSeverity,
    reason: r.reason,
    meetingId: r.meeting_id,
    occurrenceCount: r.occurrence_count,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  }));
}
