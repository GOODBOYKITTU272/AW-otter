import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

// The generated RPC arg types mark nullable params as non-nullable
// (a known codegen gap — see packages/domain/src/transcription.ts's own
// note on the same issue). These casts only relax that codegen gap, they
// do not change what's actually sent.
type ResolveCallRecordArgs =
  Database["public"]["Functions"]["resolve_call_record"]["Args"];
type AssignCallRecordOwnerArgs =
  Database["public"]["Functions"]["assign_call_record_owner"]["Args"];

export type AppSupabaseClient = SupabaseClient<Database>;
type CallRecordRow = Database["public"]["Tables"]["call_records"]["Row"];

/**
 * M10: marks an M9-detected call_record resolved (completed or
 * cancelled). `supabase` must be the caller's OWN authenticated client —
 * resolve_call_record is a SECURITY DEFINER RPC with an embedded
 * authorization check (admin / meeting owner / manager with
 * intelligence.read). Idempotent: resolving to the SAME terminal state
 * twice returns the row unchanged; resolving to the OTHER terminal state
 * (e.g. completing something already cancelled) raises.
 */
export async function resolveCallRecord(
  supabase: AppSupabaseClient,
  recordId: string,
  resolution: "completed" | "cancelled",
  note?: string,
): Promise<CallRecordRow> {
  const { data, error } = await supabase.rpc("resolve_call_record", {
    p_record_id: recordId,
    p_resolution: resolution,
    p_note: note ?? null,
  } as ResolveCallRecordArgs);
  if (error) throw error;
  return data;
}

/**
 * M10: assigns (or reassigns) a call_record's owner and optionally its
 * due date. The RPC itself validates the target membership is real,
 * active, and in the caller's own organization before assigning it.
 */
export async function assignCallRecordOwner(
  supabase: AppSupabaseClient,
  recordId: string,
  ownerMembershipId: string,
  dueAt?: string,
): Promise<CallRecordRow> {
  const { data, error } = await supabase.rpc("assign_call_record_owner", {
    p_record_id: recordId,
    p_owner_membership_id: ownerMembershipId,
    p_due_at: dueAt ?? null,
  } as AssignCallRecordOwnerArgs);
  if (error) throw error;
  return data;
}
