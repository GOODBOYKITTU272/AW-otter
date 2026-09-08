import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

type CustomerLinkStatus = Database["public"]["Enums"]["customer_link_status"];
type CallType = Database["public"]["Enums"]["call_type"];
type NeedsLinkReason = "no_match" | "multiple_matches" | "owner_conflict";

// A meeting in one of these states was already decided — by automation or
// a human — and is never re-evaluated. This is what makes repeated
// reconciliation idempotent AND what stops automation from overriding a
// deliberate "leave unlinked" decision (design doc §4/§6).
const RESOLVED_STATUSES: readonly CustomerLinkStatus[] = [
  "linked_auto",
  "linked_manual",
  "unlinked",
];

interface MeetingLinkageRow {
  id: string;
  organization_id: string;
  owner_membership_id: string | null;
  eligibility_status: string;
  lifecycle_status: string;
  customer_id: string | null;
  customer_link_status: CustomerLinkStatus | null;
}

async function loadMeetingForLinkage(
  client: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
): Promise<MeetingLinkageRow> {
  const { data, error } = await client
    .from("meetings")
    .select(
      "id, organization_id, owner_membership_id, eligibility_status, lifecycle_status, customer_id, customer_link_status",
    )
    .eq("id", meetingId)
    .eq("organization_id", organizationId)
    .single();
  if (error) throw error;
  return data;
}

/**
 * Codex's post-implementation M7A review (BLOCKING): reading a meeting
 * through the caller's own authenticated client is NOT sufficient
 * authorization for a linkage/call-type mutation — meetings RLS also lets
 * a manager with `exceptions.approve` read a direct report's meeting
 * (meetings_select_manager_scope, M5), which is a narrower purpose than
 * "may manage this meeting's customer linkage." M7A's own scope is
 * AM-own or Admin only (design doc — manager visibility into customers is
 * explicitly deferred), so every manual action re-asserts that directly
 * instead of trusting "I could read it."
 */
function assertCallerOwnsOrAdmin(
  meetingOwnerMembershipId: string | null,
  actorMembershipId: string,
  actorRoleKey: string,
): void {
  if (actorRoleKey === "admin") return;
  if (meetingOwnerMembershipId === actorMembershipId) return;
  throw new Error(
    "You are not authorized to manage this meeting's customer link.",
  );
}

/**
 * CAS-guarded write to meetings' linkage columns. `expected` is the exact
 * customer_link_status just read — Supabase-js's `.eq(col, null)` does NOT
 * mean IS NULL, so a null expectation uses `.is()` instead. A miss (0 rows)
 * means something else already changed this meeting's link since it was
 * read; see writeLinkStatus's callers for how each treats that
 * (reconciliation self-heals silently, manual actions surface a conflict).
 *
 * `expectedCustomerId` is an ADDITIONAL guard, required for manual actions
 * (Codex's post-implementation review, BLOCKING): status alone isn't
 * enough once the starting state is already 'linked_manual' — two
 * concurrent corrections FROM the same status but pointed at different
 * customers would otherwise both satisfy a status-only CAS check, since
 * neither write changes customer_link_status's own value. Guarding on the
 * exact customer_id just read (including the `null` "not yet linked"
 * case, via `.is()`) closes that gap. The automatic path doesn't pass
 * this — its transitions are already fully described by status, since a
 * needs_link/null meeting has no prior customer_id to disagree about.
 */
async function writeLinkStatus(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
  expected: CustomerLinkStatus | null,
  update: {
    customer_id?: string | null;
    customer_link_status: CustomerLinkStatus;
    needs_link_reason?: string | null;
    linked_at?: string | null;
    linked_by_membership_id?: string | null;
  },
  expectedCustomerId?: { value: string | null },
): Promise<boolean> {
  let base = serviceRoleClient
    .from("meetings")
    .update(update)
    .eq("id", meetingId)
    .eq("organization_id", organizationId);

  base =
    expected === null
      ? base.is("customer_link_status", null)
      : base.eq("customer_link_status", expected);
  if (expectedCustomerId) {
    base =
      expectedCustomerId.value === null
        ? base.is("customer_id", null)
        : base.eq("customer_id", expectedCustomerId.value);
  }

  const { data, error } = await base.select("id").maybeSingle();
  if (error) throw error;
  return data !== null;
}

export interface EvaluateLinkageResult {
  status: "skipped" | "cancelled" | "linked_auto" | "needs_link";
  reason?: NeedsLinkReason;
}

async function writeNeedsLink(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
  expected: CustomerLinkStatus | null,
  reason: NeedsLinkReason,
): Promise<EvaluateLinkageResult> {
  const wrote = await writeLinkStatus(
    serviceRoleClient,
    meetingId,
    organizationId,
    expected,
    {
      customer_link_status: "needs_link",
      needs_link_reason: reason,
    },
  );
  return wrote ? { status: "needs_link", reason } : { status: "skipped" };
}

/**
 * The single automatic tier (design doc §4 — there is no CRM scheduled-
 * call signal to form a higher-confidence tier from in M7A). One call,
 * fully idempotent, safe to call repeatedly for the same meeting from any
 * number of callers — resolved meetings (RESOLVED_STATUSES) are never
 * touched again, and every write is CAS-guarded against the exact status
 * just read.
 */
export async function evaluateMeetingCustomerLinkage(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
  organizationId: string,
): Promise<EvaluateLinkageResult> {
  const meeting = await loadMeetingForLinkage(
    serviceRoleClient,
    meetingId,
    organizationId,
  );

  if (meeting.lifecycle_status === "cancelled") {
    if (meeting.customer_link_status === "cancelled")
      return { status: "skipped" };
    const wrote = await writeLinkStatus(
      serviceRoleClient,
      meetingId,
      organizationId,
      meeting.customer_link_status,
      {
        customer_link_status: "cancelled",
      },
    );
    return wrote ? { status: "cancelled" } : { status: "skipped" };
  }

  // Hard pre-filter: only record-eligible meetings ever enter this
  // pipeline. A meeting that fails this stays customer_link_status=null
  // (not applicable) — it isn't "waiting to be linked", it's out of scope.
  if (meeting.eligibility_status !== "record") return { status: "skipped" };
  if (!meeting.owner_membership_id) return { status: "skipped" };

  if (
    meeting.customer_link_status &&
    RESOLVED_STATUSES.includes(meeting.customer_link_status)
  ) {
    return { status: "skipped" };
  }

  const { data: organization, error: organizationError } =
    await serviceRoleClient
      .from("organizations")
      .select("email_domain")
      .eq("id", organizationId)
      .single();
  if (organizationError) throw organizationError;
  // Can't determine "external" without a configured domain — same
  // reasoning as meeting-policy.ts's external_client rule. Skip rather
  // than guess.
  if (!organization.email_domain) return { status: "skipped" };

  const { data: attendees, error: attendeesError } = await serviceRoleClient
    .from("meeting_attendees")
    .select("email")
    .eq("meeting_id", meetingId);
  if (attendeesError) throw attendeesError;

  const domainSuffix = `@${organization.email_domain}`.toLowerCase();
  const externalEmails = Array.from(
    new Set(
      (attendees ?? [])
        .map((a) => (a.email ?? "").trim().toLowerCase())
        .filter((email) => email.length > 0 && !email.endsWith(domainSuffix)),
    ),
  );

  // Internal-only meeting — never enters the pipeline, per the hard
  // pre-filter. Deliberately distinct from "needs_link": there's nothing
  // to resolve here.
  if (externalEmails.length === 0) return { status: "skipped" };

  const { data: contacts, error: contactsError } = await serviceRoleClient
    .from("customer_contacts")
    .select("customer_id")
    .eq("organization_id", organizationId)
    .in("email", externalEmails);
  if (contactsError) throw contactsError;

  const matchedCustomerIds = Array.from(
    new Set((contacts ?? []).map((c) => c.customer_id)),
  );
  if (matchedCustomerIds.length === 0) {
    return writeNeedsLink(
      serviceRoleClient,
      meetingId,
      organizationId,
      meeting.customer_link_status,
      "no_match",
    );
  }

  // Codex's post-implementation review (SHOULD-FIX): every service-role
  // query should carry its own organization_id filter independently,
  // since service_role bypasses RLS entirely — matchedCustomerIds is
  // already org-scoped via the contacts query above (and the org-
  // consistency trigger guarantees a contact's customer shares its org),
  // but this table's own predicate shouldn't rely on that alone.
  const { data: customers, error: customersError } = await serviceRoleClient
    .from("customers")
    .select("id, owner_membership_id")
    .eq("organization_id", organizationId)
    .in("id", matchedCustomerIds);
  if (customersError) throw customersError;

  const sameAmCustomerIds = Array.from(
    new Set(
      (customers ?? [])
        .filter((c) => c.owner_membership_id === meeting.owner_membership_id)
        .map((c) => c.id),
    ),
  );

  // A match exists but belongs to a DIFFERENT AM than the meeting
  // organizer — flagged distinctly from "no contact at all" (design §4
  // "AM ownership conflicts").
  if (sameAmCustomerIds.length === 0) {
    return writeNeedsLink(
      serviceRoleClient,
      meetingId,
      organizationId,
      meeting.customer_link_status,
      "owner_conflict",
    );
  }
  if (sameAmCustomerIds.length > 1) {
    return writeNeedsLink(
      serviceRoleClient,
      meetingId,
      organizationId,
      meeting.customer_link_status,
      "multiple_matches",
    );
  }

  const [customerId] = sameAmCustomerIds;
  const wrote = await writeLinkStatus(
    serviceRoleClient,
    meetingId,
    organizationId,
    meeting.customer_link_status,
    {
      customer_id: customerId,
      customer_link_status: "linked_auto",
      needs_link_reason: null,
      linked_at: new Date().toISOString(),
      linked_by_membership_id: null,
    },
  );
  if (!wrote) return { status: "skipped" }; // lost the race to a concurrent manual action

  await logAuditEvent(serviceRoleClient, {
    organizationId,
    actorId: null,
    action: "meeting_customer.linked_auto",
    entityType: "meeting",
    entityId: meetingId,
    metadata: { customerId },
  });

  return { status: "linked_auto" };
}

export interface ReconcileLinkageResult {
  meetingsScanned: number;
}

/**
 * Decoupled batch reconciler — callable on demand via an internal route,
 * same shape as M4/M5/M6's own reconciliation. Scans both upcoming and
 * cancelled meetings in one pass; evaluateMeetingCustomerLinkage's own
 * lifecycle_status branch is what actually applies the 'cancelled' sweep,
 * so no separate function is needed for it.
 */
export async function reconcileOrganizationCustomerLinkage(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<ReconcileLinkageResult> {
  const { data: meetings, error } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("organization_id", organizationId)
    .in("lifecycle_status", ["upcoming", "cancelled"]);
  if (error) throw error;

  for (const meeting of meetings ?? []) {
    await evaluateMeetingCustomerLinkage(
      serviceRoleClient,
      meeting.id,
      organizationId,
    );
  }

  return { meetingsScanned: meetings?.length ?? 0 };
}

export interface LinkMeetingToCustomerInput {
  meetingId: string;
  organizationId: string;
  customerId: string;
  actorMembershipId: string;
  actorRoleKey: string;
  actorUserId: string;
}

/**
 * Manual link AND correction are the same operation — "point this meeting
 * at this customer" — audited under different action names depending on
 * whether a link already existed. `supabase` must be the caller's OWN
 * authenticated client: reading the meeting/customer through it confirms
 * the rows are at least visible to the caller (RLS), but visibility alone
 * is NOT authorization to mutate — assertCallerOwnsOrAdmin adds the actual
 * M7A scope (AM-own or Admin only) that a manager's broader read-only
 * exception-review visibility doesn't imply. The write itself needs
 * `serviceRoleClient` (meetings writes are service-role only) and is
 * CAS-guarded against BOTH the exact customer_link_status and the exact
 * customer_id just read — status alone isn't enough once the starting
 * state is already 'linked_manual' (see writeLinkStatus's own doc). A
 * miss means the link changed concurrently and is surfaced as a conflict,
 * not silently overwritten.
 */
export async function linkMeetingToCustomer(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: LinkMeetingToCustomerInput,
): Promise<void> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, owner_membership_id, customer_id, customer_link_status")
    .eq("id", input.meetingId)
    .single();
  if (meetingError) throw meetingError;

  assertCallerOwnsOrAdmin(
    meeting.owner_membership_id,
    input.actorMembershipId,
    input.actorRoleKey,
  );

  const { data: customer, error: customerError } = await supabase
    .from("customers")
    .select("id, owner_membership_id")
    .eq("id", input.customerId)
    .single();
  if (customerError) throw customerError;

  if (customer.owner_membership_id !== meeting.owner_membership_id) {
    throw new Error(
      "This customer must be owned by the same Account Manager as the meeting organizer.",
    );
  }

  const wasAlreadyLinked =
    meeting.customer_link_status === "linked_auto" ||
    meeting.customer_link_status === "linked_manual";

  const wrote = await writeLinkStatus(
    serviceRoleClient,
    input.meetingId,
    input.organizationId,
    meeting.customer_link_status,
    {
      customer_id: input.customerId,
      customer_link_status: "linked_manual",
      needs_link_reason: null,
      linked_at: new Date().toISOString(),
      linked_by_membership_id: input.actorMembershipId,
    },
    { value: meeting.customer_id },
  );
  if (!wrote) {
    throw new Error(
      "This meeting's customer link changed elsewhere — refresh and try again.",
    );
  }

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: wasAlreadyLinked
      ? "meeting_customer.corrected"
      : "meeting_customer.linked_manual",
    entityType: "meeting",
    entityId: input.meetingId,
    metadata: {
      customerId: input.customerId,
      previousCustomerId: meeting.customer_id,
    },
  });
}

export interface UnlinkMeetingInput {
  meetingId: string;
  organizationId: string;
  actorMembershipId: string;
  actorRoleKey: string;
  actorUserId: string;
}

/**
 * Covers both "leave unlinked" (from needs_link — nothing to give up) and
 * "unlink" (removing an existing linked_auto/linked_manual link) — same
 * mechanics, distinguished in the audit action name and metadata (Codex's
 * post-implementation review, SHOULD-FIX) since they're different-weight
 * decisions even though the resulting state is identical. CAS-guarded on
 * both status and customer_id, same reasoning as linkMeetingToCustomer.
 */
export async function unlinkMeeting(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: UnlinkMeetingInput,
): Promise<void> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, owner_membership_id, customer_id, customer_link_status")
    .eq("id", input.meetingId)
    .single();
  if (meetingError) throw meetingError;

  assertCallerOwnsOrAdmin(
    meeting.owner_membership_id,
    input.actorMembershipId,
    input.actorRoleKey,
  );

  const hadExistingLink =
    meeting.customer_link_status === "linked_auto" ||
    meeting.customer_link_status === "linked_manual";

  const wrote = await writeLinkStatus(
    serviceRoleClient,
    input.meetingId,
    input.organizationId,
    meeting.customer_link_status,
    {
      customer_id: null,
      customer_link_status: "unlinked",
      needs_link_reason: null,
      linked_at: null,
      linked_by_membership_id: null,
    },
    { value: meeting.customer_id },
  );
  if (!wrote) {
    throw new Error(
      "This meeting's customer link changed elsewhere — refresh and try again.",
    );
  }

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: hadExistingLink
      ? "meeting_customer.unlinked"
      : "meeting_customer.left_unlinked",
    entityType: "meeting",
    entityId: input.meetingId,
    metadata: {
      previousCustomerId: meeting.customer_id,
      previousStatus: meeting.customer_link_status,
    },
  });
}

export interface ConfirmCallTypeInput {
  meetingId: string;
  organizationId: string;
  callType: CallType;
  actorMembershipId: string;
  actorRoleKey: string;
  actorUserId: string;
}

/**
 * Never inferred — the AM always explicitly confirms (design doc §5). No
 * CAS guard needed here: unlike customer_link_status, nothing automated
 * ever writes call_type, so there's no automation-vs-human race to guard
 * against, only two humans re-confirming in quick succession, where
 * last-write-wins (still fully audited) is an acceptable outcome — Codex's
 * post-implementation review re-checked this reasoning specifically and
 * confirmed it still holds. Ownership IS re-asserted here, though (same
 * fix as the other two manual actions): meeting read-visibility alone
 * (e.g. a manager's exception-review scope) isn't M7A authorization.
 */
export async function confirmCallType(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: ConfirmCallTypeInput,
): Promise<void> {
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id, owner_membership_id, customer_id")
    .eq("id", input.meetingId)
    .single();
  if (meetingError) throw meetingError;

  assertCallerOwnsOrAdmin(
    meeting.owner_membership_id,
    input.actorMembershipId,
    input.actorRoleKey,
  );

  if (!meeting.customer_id) {
    throw new Error(
      "Link this meeting to a customer before confirming a call type.",
    );
  }

  const { error: updateError } = await serviceRoleClient
    .from("meetings")
    .update({
      call_type: input.callType,
      call_type_source: "am_confirmed",
      call_type_confirmed_by_membership_id: input.actorMembershipId,
      call_type_confirmed_at: new Date().toISOString(),
    })
    .eq("id", input.meetingId)
    .eq("organization_id", input.organizationId);
  if (updateError) throw updateError;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "meeting_call_type.confirmed",
    entityType: "meeting",
    entityId: input.meetingId,
    metadata: { callType: input.callType },
  });
}
