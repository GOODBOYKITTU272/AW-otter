import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import {
  getCustomerDetails,
  TRUTH_FIELD_KEYS,
  type NormalizedCrmBaseline,
} from "@applywizz/crm";

export type AppSupabaseClient = SupabaseClient<Database>;

export class CustomerNotVisibleError extends Error {
  constructor() {
    super("Customer not found or not visible to the current user.");
    this.name = "CustomerNotVisibleError";
  }
}

export class CustomerHasNoExternalIdentityError extends Error {
  constructor() {
    super(
      "This customer has no external_applywizz_id — nothing to hydrate from the CRM.",
    );
    this.name = "CustomerHasNoExternalIdentityError";
  }
}

export interface HydrateCrmBaselineDeps {
  crmBaseUrl: string;
  crmApiKey: string | null;
}

export interface HydrateCrmBaselineResult {
  /** false when the fetch succeeded but content was byte-identical to the latest existing snapshot — idempotent no-op, not an error. */
  hydrated: boolean;
  snapshotId: string | null;
}

/**
 * M10 amendment: server-side CRM baseline hydration.
 * `supabase` MUST be the caller's OWN authenticated client — reading the
 * customer through it is the actual authorization proof (RLS returns
 * null for a customer this user can't see, same "visibility check via
 * the caller's own client" pattern as linkMeetingToCustomer/
 * requestDoNotRecord). The upstream fetch and the actual snapshot write
 * both happen server-side only — this function is never called from
 * browser code, and @applywizz/crm's client is the only thing that ever
 * calls the real upstream URL. `external_applywizz_id` is read from
 * Signal's own `customers` row, never accepted as a caller-supplied
 * parameter — a request can never become an arbitrary CRM lookup proxy
 * for an AWL id the caller merely typed in.
 */
export async function hydrateCustomerCrmBaseline(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  deps: HydrateCrmBaselineDeps,
  customerId: string,
): Promise<HydrateCrmBaselineResult> {
  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, organization_id, external_applywizz_id")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!customer) throw new CustomerNotVisibleError();
  if (!customer.external_applywizz_id) {
    throw new CustomerHasNoExternalIdentityError();
  }

  const result = await getCustomerDetails(
    deps.crmBaseUrl,
    customer.external_applywizz_id,
    deps.crmApiKey,
  );

  const contentFingerprint = createHash("sha256")
    .update(JSON.stringify(result.normalized))
    .digest("hex");

  const { data: inserted, error: insertError } = await serviceRoleClient
    .from("customer_context_snapshots")
    .insert({
      organization_id: customer.organization_id,
      customer_id: customer.id,
      external_applywizz_id: customer.external_applywizz_id,
      normalized_data: result.normalized as unknown as Json,
      source_updated_at: result.sourceUpdatedAt,
      content_fingerprint: contentFingerprint,
    })
    .select("id")
    .single();

  if (insertError) {
    // Codex-lesson-applied: the unique constraint on
    // (customer_id, content_fingerprint) is the real idempotency
    // enforcement, not application-level "check then insert" (which
    // would race). A 23505 here means a fetch already produced this
    // exact normalized content — a genuine no-op, not a failure.
    if (insertError.code === "23505") {
      return { hydrated: false, snapshotId: null };
    }
    throw insertError;
  }

  return { hydrated: true, snapshotId: inserted.id };
}

export type TruthProvenance = "signal_confirmed" | "crm_baseline" | "none";

export interface EffectiveTruthField {
  fieldKey: (typeof TRUTH_FIELD_KEYS)[number];
  crmBaseline: unknown;
  currentValue: unknown;
  provenance: TruthProvenance;
}

/**
 * §2's locked precedence: confirmed Signal truth wins over the CRM
 * baseline; the CRM baseline is only ever the fallback for a field with
 * no confirmed Signal fact yet. A CRM refresh can never overwrite a
 * confirmed Signal fact — this function doesn't even give it the
 * opportunity to: confirmedByField is checked FIRST for every field, and
 * customer_context_snapshots is never written to customer_truth_facts
 * anywhere in this codebase.
 */
export async function getEffectiveCustomerTruth(
  supabase: AppSupabaseClient,
  customerId: string,
): Promise<EffectiveTruthField[]> {
  const { data: confirmed, error: confirmedError } = await supabase
    .from("customer_truth_current")
    .select("field_key, value")
    .eq("customer_id", customerId);
  if (confirmedError) throw confirmedError;
  const confirmedByField = new Map<string, unknown>(
    (confirmed ?? []).map((row) => [row.field_key as string, row.value]),
  );

  const { data: snapshot, error: snapshotError } = await supabase
    .from("customer_context_snapshots")
    .select("normalized_data")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshotError) throw snapshotError;
  const baseline =
    (snapshot?.normalized_data as unknown as NormalizedCrmBaseline | null)
      ?.truthFields ?? null;

  return TRUTH_FIELD_KEYS.map((fieldKey) => {
    const crmValue = baseline ? baseline[fieldKey] : null;
    if (confirmedByField.has(fieldKey)) {
      return {
        fieldKey,
        crmBaseline: crmValue,
        currentValue: confirmedByField.get(fieldKey),
        provenance: "signal_confirmed" as const,
      };
    }
    if (crmValue !== null && crmValue !== undefined) {
      return {
        fieldKey,
        crmBaseline: crmValue,
        currentValue: crmValue,
        provenance: "crm_baseline" as const,
      };
    }
    return {
      fieldKey,
      crmBaseline: crmValue,
      currentValue: null,
      provenance: "none" as const,
    };
  });
}

function normalizeForComparison(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return [...value].map((v) => String(v).trim().toLowerCase()).sort();
  }
  if (typeof value === "string") return value.trim().toLowerCase();
  return value;
}

/**
 * §11: deterministic structured comparison — order-insensitive for
 * arrays, case/whitespace-insensitive for strings — so an M9 proposal
 * that's already semantically reflected in the effective current truth
 * can be labeled "no change" without a second AI call.
 */
export function isSemanticallySameValue(a: unknown, b: unknown): boolean {
  return (
    JSON.stringify(normalizeForComparison(a)) ===
    JSON.stringify(normalizeForComparison(b))
  );
}
