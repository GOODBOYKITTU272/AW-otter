import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

export interface CreateCustomerInput {
  organizationId: string;
  name: string;
  ownerMembershipId: string;
  actorMembershipId: string;
  actorUserId: string;
}

/**
 * `supabase` must be the caller's OWN authenticated client —
 * customers_insert_own_org (M7A RLS) is the actual enforcement of "own org,
 * source_type='manual', self-or-admin owner, created_by is the caller";
 * this function doesn't duplicate that check, it relies on it failing
 * loudly (a thrown Postgres 42501) if violated. Same shape as
 * recording-exceptions.ts's requestDoNotRecord.
 *
 * Codex's post-implementation M7A review (SHOULD-FIX): `created_by_
 * membership_id` records who actually created a manual row (the acting
 * AM/Admin), distinct from `owner_membership_id` (who the customer is
 * assigned to) — an Admin creating a customer on an AM's behalf is the
 * case these two fields need to disagree for.
 */
export async function createCustomer(
  supabase: AppSupabaseClient,
  input: CreateCustomerInput,
): Promise<{ customerId: string }> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new Error("A customer name is required.");
  }

  const { data: customer, error } = await supabase
    .from("customers")
    .insert({
      organization_id: input.organizationId,
      name,
      owner_membership_id: input.ownerMembershipId,
      created_by_membership_id: input.actorMembershipId,
      source_type: "manual",
    })
    .select("id")
    .single();
  if (error) throw error;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "customer.created",
    entityType: "customer",
    entityId: customer.id,
    metadata: { name, ownerMembershipId: input.ownerMembershipId },
  });

  return { customerId: customer.id };
}

export interface AddCustomerContactInput {
  organizationId: string;
  customerId: string;
  email: string;
  actorUserId: string;
}

/**
 * Codex plan review (SHOULD-FIX #4): the org-wide unique(organization_id,
 * email) constraint that makes customer-linkage matching trustworthy also
 * means a duplicate insert reveals THAT an email already belongs to some
 * customer in the org — never WHICH one (Postgres's own unique-violation
 * error carries no other-row data). That narrow, same-org existence signal
 * is an accepted limitation for M7A, not something a mediation layer needs
 * to hide; what this function does do is turn the raw Postgres error into
 * a clean, generic domain error instead of leaking constraint-name text.
 */
export async function addCustomerContact(
  supabase: AppSupabaseClient,
  input: AddCustomerContactInput,
): Promise<{ contactId: string }> {
  const email = input.email.trim().toLowerCase();
  if (email.length === 0) {
    throw new Error("A contact email is required.");
  }

  const { data: contact, error } = await supabase
    .from("customer_contacts")
    .insert({
      organization_id: input.organizationId,
      customer_id: input.customerId,
      email,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new Error(
        "This email is already associated with a customer in this organization.",
      );
    }
    throw error;
  }

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "customer_contact.added",
    entityType: "customer",
    entityId: input.customerId,
    metadata: { contactId: contact.id, email },
  });

  return { contactId: contact.id };
}
