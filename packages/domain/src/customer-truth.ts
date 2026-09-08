import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

type SeedSourceType = Extract<
  Database["public"]["Enums"]["customer_truth_source_type"],
  "manual" | "onboarding_form"
>;

export interface SeedCustomerTruthFactInput {
  organizationId: string;
  customerId: string;
  fieldKey: string;
  value: Json;
  sourceType: SeedSourceType;
  confirmedByMembershipId: string;
  actorUserId: string;
}

/**
 * M7A only — manual/onboarding_form seeding, always written `confirmed`
 * directly: entering this data IS the human confirmation, there's no AI
 * inference step to gate (locked in both design docs). Building an
 * AI-detected/`proposed` path is explicitly out of scope until M9/M10
 * exist. `supabase` must be the caller's OWN authenticated client —
 * customer_truth_facts_insert_manual_seed (M7A RLS) is the actual
 * enforcement of source_type/status/evidence/confirmer shape; this
 * function doesn't duplicate that WITH CHECK, it relies on it failing
 * loudly if violated.
 */
export async function seedCustomerTruthFact(
  supabase: AppSupabaseClient,
  input: SeedCustomerTruthFactInput,
): Promise<{ factId: string }> {
  const fieldKey = input.fieldKey.trim();
  if (fieldKey.length === 0) {
    throw new Error("A field_key is required.");
  }

  const { data: fact, error } = await supabase
    .from("customer_truth_facts")
    .insert({
      organization_id: input.organizationId,
      customer_id: input.customerId,
      field_key: fieldKey,
      value: input.value,
      status: "confirmed",
      source_type: input.sourceType,
      confirmed_by_membership_id: input.confirmedByMembershipId,
      confirmed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "customer_truth.seeded",
    entityType: "customer",
    entityId: input.customerId,
    metadata: { factId: fact.id, fieldKey, sourceType: input.sourceType },
  });

  return { factId: fact.id };
}
