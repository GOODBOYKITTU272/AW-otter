import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;
type CustomerTruthFactRow =
  Database["public"]["Tables"]["customer_truth_facts"]["Row"];
// Codegen gap: generated RPC arg types mark nullable params as
// non-nullable. This cast only relaxes that, it doesn't change what's sent.
type RejectCustomerTruthFactArgs =
  Database["public"]["Functions"]["reject_customer_truth_fact"]["Args"];

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

/**
 * M10: promotes a proposed (M9-detected) fact into confirmed current
 * truth, atomically superseding whatever was previously confirmed for
 * the same field. `supabase` must be the caller's OWN authenticated
 * client — confirm_customer_truth_fact is a SECURITY DEFINER RPC that
 * embeds its own authorization check (admin / customer owner / manager
 * with intelligence.read) using auth.uid(), it is never called with a
 * service-role client. Idempotent: confirming an already-confirmed fact
 * returns it unchanged rather than erroring; confirming a fact that's
 * rejected/superseded raises, which surfaces here as a thrown error.
 */
export async function confirmCustomerTruthFact(
  supabase: AppSupabaseClient,
  factId: string,
): Promise<CustomerTruthFactRow> {
  const { data, error } = await supabase.rpc("confirm_customer_truth_fact", {
    p_fact_id: factId,
  });
  if (error) throw error;
  return data;
}

/** M10: the reject counterpart of confirmCustomerTruthFact — see its doc comment. */
export async function rejectCustomerTruthFact(
  supabase: AppSupabaseClient,
  factId: string,
  reason?: string,
): Promise<CustomerTruthFactRow> {
  const { data, error } = await supabase.rpc("reject_customer_truth_fact", {
    p_fact_id: factId,
    p_reason: reason ?? null,
  } as RejectCustomerTruthFactArgs);
  if (error) throw error;
  return data;
}
