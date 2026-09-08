import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import {
  listCalls,
  RECONCILE_LOOKAHEAD_DAYS,
  RECONCILE_LOOKBACK_DAYS,
  type SchedulerCall,
} from "@applywizz/scheduler";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

type CallType = Database["public"]["Enums"]["call_type"];

/**
 * Every value observed across the full live scheduler dataset (readiness
 * investigation, 2026-09-08). Anything else maps to 'other_unknown' rather
 * than throwing — the scheduler is free to add a new type without a Signal
 * migration breaking ingestion. 'PROGRESS_REVIEW' -> 'progress' (not
 * 'day15_progress'): the source contract only guarantees "a progress
 * review happened", not a Day-15 cadence.
 */
const EXTERNAL_TYPE_MAP: Record<string, CallType> = {
  DISCOVERY: "discovery",
  ORIENTATION: "orientation",
  PROGRESS_REVIEW: "progress",
  RENEWAL_DISCUSSION: "renewal",
};

export function mapExternalCallType(externalType: string): CallType {
  return EXTERNAL_TYPE_MAP[externalType] ?? "other_unknown";
}

/**
 * The path segment (which encodes the Teams thread/meeting id) is the
 * actual identity; a `?context=...` query string can legitimately differ
 * per recipient for the SAME meeting (Graph hands each attendee their own
 * context blob), so it's stripped before comparing. Falls back to a plain
 * lowercase/trim if the value isn't a parseable URL at all, rather than
 * throwing — this only ever feeds an equality comparison, never a request.
 */
export function normalizeTeamsLink(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    return `${parsed.origin}${parsed.pathname}`
      .toLowerCase()
      .replace(/\/+$/, "");
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Same-org, active, account_manager-role membership for a scheduler am_email. Returns null (never guesses) if it doesn't resolve. */
async function resolveManagedAmMembership(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  amEmail: string,
): Promise<string | null> {
  const email = amEmail.trim().toLowerCase();
  if (email.length === 0) return null;

  const { data: membership, error } = await serviceRoleClient
    .from("organization_memberships")
    .select("id, role_id")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .eq("work_email", email)
    .maybeSingle();
  if (error) throw error;
  if (!membership) return null;

  const { data: role, error: roleError } = await serviceRoleClient
    .from("roles")
    .select("key")
    .eq("id", membership.role_id)
    .maybeSingle();
  if (roleError) throw roleError;
  if (role?.key !== "account_manager") return null;

  return membership.id;
}

interface UpsertCustomerResult {
  customerId: string;
  ownerMembershipId: string;
  created: boolean;
}

/**
 * lead_id is the ONLY signal allowed to resolve customer identity here —
 * never client_email (revised M7A plan: "different lead_ids must NEVER
 * silently merge only because email matches"). The org-scoped partial
 * unique index (customers_org_external_applywizz_id_uq) is the actual
 * enforcement; a 23505 on insert means a concurrent sync pass won the
 * race, and this just reads back what it created.
 */
async function upsertCustomerForLead(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  input: {
    leadId: string;
    clientName: string | null;
    ownerMembershipId: string;
  },
): Promise<UpsertCustomerResult> {
  const { data: existing, error } = await serviceRoleClient
    .from("customers")
    .select("id, owner_membership_id, name")
    .eq("organization_id", organizationId)
    .eq("external_applywizz_id", input.leadId)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    if (input.clientName && input.clientName !== existing.name) {
      const { error: updateError } = await serviceRoleClient
        .from("customers")
        .update({ name: input.clientName })
        .eq("id", existing.id)
        .eq("organization_id", organizationId);
      if (updateError) throw updateError;
    }
    return {
      customerId: existing.id,
      ownerMembershipId: existing.owner_membership_id,
      created: false,
    };
  }

  const { data: created, error: insertError } = await serviceRoleClient
    .from("customers")
    .insert({
      organization_id: organizationId,
      external_applywizz_id: input.leadId,
      name: input.clientName ?? input.leadId,
      owner_membership_id: input.ownerMembershipId,
      source_type: "external_scheduler",
    })
    .select("id, owner_membership_id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      const { data: raced, error: racedError } = await serviceRoleClient
        .from("customers")
        .select("id, owner_membership_id")
        .eq("organization_id", organizationId)
        .eq("external_applywizz_id", input.leadId)
        .single();
      if (racedError) throw racedError;
      return {
        customerId: raced.id,
        ownerMembershipId: raced.owner_membership_id,
        created: false,
      };
    }
    throw insertError;
  }

  await logAuditEvent(serviceRoleClient, {
    organizationId,
    actorId: null,
    action: "scheduler_customer.created",
    entityType: "customer",
    entityId: created.id,
    metadata: { leadId: input.leadId },
  });

  return {
    customerId: created.id,
    ownerMembershipId: created.owner_membership_id,
    created: true,
  };
}

/**
 * "Customer = permanent, call owner = can change" (revised plan): after
 * every scheduler_calls upsert, the customer's own owner_membership_id is
 * re-derived from whichever of ITS scheduler_calls rows has the latest
 * scheduled_at — deterministic regardless of which AM's sync pass runs
 * last, and self-correcting on the next sync if this write loses a race
 * (CAS-guarded on the owner value just read).
 */
async function reresolveCustomerOwner(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  customerId: string,
  currentOwnerMembershipId: string,
): Promise<boolean> {
  // Codex post-implementation review (SHOULD-FIX): scheduled_at alone
  // isn't a unique ordering key — two rows can share the exact same
  // timestamp with different owners (e.g. a same-slot reschedule mid-sync),
  // and Postgres does not guarantee which one a tied ORDER BY returns.
  // external_call_id (globally unique per row) is a fully deterministic
  // tiebreaker, so the same input state always resolves the same owner
  // regardless of physical row order.
  const { data: latest, error } = await serviceRoleClient
    .from("scheduler_calls")
    .select("owner_membership_id")
    .eq("organization_id", organizationId)
    .eq("customer_id", customerId)
    .order("scheduled_at", { ascending: false })
    .order("external_call_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!latest || latest.owner_membership_id === currentOwnerMembershipId)
    return false;

  const { data: updated, error: updateError } = await serviceRoleClient
    .from("customers")
    .update({ owner_membership_id: latest.owner_membership_id })
    .eq("id", customerId)
    .eq("organization_id", organizationId)
    .eq("owner_membership_id", currentOwnerMembershipId)
    .select("id")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!updated) return false;

  await logAuditEvent(serviceRoleClient, {
    organizationId,
    actorId: null,
    action: "scheduler_customer.owner_reassigned",
    entityType: "customer",
    entityId: customerId,
    metadata: {
      previousOwnerMembershipId: currentOwnerMembershipId,
      newOwnerMembershipId: latest.owner_membership_id,
    },
  });
  return true;
}

/**
 * customer_contacts keeps its M7A org-wide unique(organization_id, email)
 * constraint — built for the OLD attendee-email matching tier, where one
 * email really must map to one customer. Under lead_id-first identity that
 * assumption can legitimately break (a shared/reused email across two
 * real leads) — when it does, this never repoints the email to the new
 * customer (that WOULD be the silent merge the revised plan forbids); it
 * just leaves the existing mapping alone. The new customer is still fully
 * correct and resolvable via external_applywizz_id; it just gets no
 * contact-based fallback route for that particular email.
 */
async function syncCustomerContact(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  customerId: string,
  email: string | null,
  name: string | null,
): Promise<void> {
  if (!email) return;
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail.length === 0) return;

  const { data: existing, error } = await serviceRoleClient
    .from("customer_contacts")
    .select("id, customer_id")
    .eq("organization_id", organizationId)
    .eq("email", normalizedEmail)
    .maybeSingle();
  if (error) throw error;

  if (existing) {
    if (existing.customer_id !== customerId) return; // claimed by a different lead — leave it
    if (name) {
      const { error: updateError } = await serviceRoleClient
        .from("customer_contacts")
        .update({ name })
        .eq("id", existing.id);
      if (updateError) throw updateError;
    }
    return;
  }

  const { error: insertError } = await serviceRoleClient
    .from("customer_contacts")
    .insert({
      organization_id: organizationId,
      customer_id: customerId,
      email: normalizedEmail,
      name,
    });
  if (insertError && insertError.code !== "23505") throw insertError;
}

interface UpsertSchedulerCallResult {
  id: string;
  meetingId: string | null;
}

/**
 * meeting_id is deliberately OMITTED from this payload (same trick as
 * upsertCanonicalMeeting's owner_membership_id omission, meetings.ts) —
 * PostgREST's upsert only touches columns present in the payload, so a
 * resync never clobbers an already-resolved match back to whatever this
 * particular sync pass would compute. Every other column always refreshes
 * (reschedule, status change, Teams metadata arriving late are all just
 * ordinary column updates).
 */
async function upsertSchedulerCallRow(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  customerId: string,
  ownerMembershipId: string,
  call: SchedulerCall,
): Promise<UpsertSchedulerCallResult> {
  const { data, error } = await serviceRoleClient
    .from("scheduler_calls")
    .upsert(
      {
        organization_id: organizationId,
        external_call_id: call.externalCallId,
        customer_id: customerId,
        external_applywizz_id: call.leadId,
        owner_membership_id: ownerMembershipId,
        external_am_email: call.amEmail,
        external_type: call.externalType,
        canonical_call_type: mapExternalCallType(call.externalType),
        call_type_source: "external_scheduler",
        scheduled_at: call.scheduledAt,
        ends_at: call.endsAt,
        external_status: call.externalStatus,
        teams_link: call.teamsLink,
        teams_event_id: call.teamsEventId,
        teams_online_meeting_id: call.teamsOnlineMeetingId,
        source_created_at: call.sourceCreatedAt,
        source_updated_at: call.sourceUpdatedAt,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,external_call_id" },
    )
    .select("id, meeting_id")
    .single();
  if (error) throw error;
  return { id: data.id, meetingId: data.meeting_id };
}

/**
 * Codex post-implementation review (BLOCKING): meeting_external_events'
 * own is_organizer flag is refreshed on every Graph sync of THAT mailbox,
 * but there is a window — between a reassignment landing via a DIFFERENT
 * mailbox's fresher sync and this specific mailbox's own next sync —
 * where this join table can still say is_organizer=true for an AM who is
 * no longer meetings.owner_membership_id for that canonical meeting.
 * Trusting the join table alone would let a stale row link a scheduler
 * call to a meeting now owned by someone else. The resolved meeting_id is
 * re-verified against meetings' own organization_id/owner_membership_id —
 * the actual current source of truth — same defense-in-depth requirement
 * already applied to Tiers 2/3 below.
 */
async function findMeetingIdByEventId(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  ownerMembershipId: string,
  amEmail: string,
  teamsEventId: string,
): Promise<string | null> {
  const { data, error } = await serviceRoleClient
    .from("meeting_external_events")
    .select("meeting_id")
    .eq("organization_id", organizationId)
    .eq("provider", "microsoft")
    .eq("provider_user_key", amEmail)
    .eq("external_event_id", teamsEventId)
    .eq("is_organizer", true)
    .maybeSingle();
  if (error) throw error;
  if (!data?.meeting_id) return null;

  const { data: meeting, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("id", data.meeting_id)
    .eq("organization_id", organizationId)
    .eq("owner_membership_id", ownerMembershipId)
    .maybeSingle();
  if (meetingError) throw meetingError;
  return meeting?.id ?? null;
}

async function findMeetingIdByTeamsLink(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  ownerMembershipId: string,
  normalizedLink: string,
): Promise<string | null> {
  const { data, error } = await serviceRoleClient
    .from("meetings")
    .select("id, meeting_url")
    .eq("organization_id", organizationId)
    .eq("owner_membership_id", ownerMembershipId)
    .not("meeting_url", "is", null);
  if (error) throw error;

  const candidates = (data ?? []).filter(
    (m) => normalizeTeamsLink(m.meeting_url) === normalizedLink,
  );
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

/**
 * ±10 minutes: real scheduler data shows AM slots packed as tight as 30
 * minutes apart (readiness investigation — consecutive PROGRESS_REVIEW
 * slots 30 min apart for the same AM). 10 minutes safely clears clock/
 * rounding noise without reaching into an adjacent slot, and any window
 * that still yields more than one candidate is treated as ambiguous and
 * left unmatched (never guessed) — see the disambiguation step below.
 */
const TIER3_TOLERANCE_MINUTES = 10;

async function findMeetingIdByScheduleMatch(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  ownerMembershipId: string,
  scheduledAt: string,
): Promise<string | null> {
  const target = new Date(scheduledAt).getTime();
  const windowStart = new Date(
    target - TIER3_TOLERANCE_MINUTES * 60_000,
  ).toISOString();
  const windowEnd = new Date(
    target + TIER3_TOLERANCE_MINUTES * 60_000,
  ).toISOString();

  const { data, error } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("owner_membership_id", ownerMembershipId)
    .gte("scheduled_start", windowStart)
    .lte("scheduled_start", windowEnd)
    .or("customer_link_status.is.null,customer_link_status.eq.needs_link");
  if (error) throw error;

  const candidateIds = (data ?? []).map((m) => m.id);
  if (candidateIds.length === 0) return null;
  if (candidateIds.length === 1) return candidateIds[0] ?? null;

  // More than one candidate in the window — exclude any a DIFFERENT
  // scheduler_calls row already claimed this pass, then require exactly
  // one survivor. Still ambiguous after that => never guess.
  const { data: claimed, error: claimedError } = await serviceRoleClient
    .from("scheduler_calls")
    .select("meeting_id")
    .eq("organization_id", organizationId)
    .in("meeting_id", candidateIds);
  if (claimedError) throw claimedError;
  const claimedIds = new Set((claimed ?? []).map((c) => c.meeting_id));
  const unclaimed = candidateIds.filter((id) => !claimedIds.has(id));
  return unclaimed.length === 1 ? (unclaimed[0] ?? null) : null;
}

/**
 * CAS-guarded on BOTH sides: scheduler_calls.meeting_id must still be null
 * (stops the same scheduler_call being claimed twice concurrently), and
 * the target meeting must still be null/needs_link (stops two different
 * scheduler_calls both claiming the same meeting, and never overwrites an
 * already-terminal linked_auto/linked_manual/unlinked meeting — the
 * existing attendee-fallback tier's own RESOLVED_STATUSES rule, applied
 * here too). A meeting-side miss releases the scheduler-side claim so a
 * later pass can retry cleanly rather than leaving an orphaned half-claim.
 */
/**
 * Codex post-implementation review (SHOULD-FIX): the scheduler_calls-side
 * claim and the meetings-side claim used to be two separate PostgREST
 * round-trips — a process death between them left an orphaned half-claim
 * (scheduler_calls terminal, meeting never actually linked, no retry
 * path). claim_scheduler_call_meeting (migration 050003) does both writes,
 * and the compensating release on a meeting-side miss, inside ONE
 * Postgres transaction — this function is now just a thin, honestly-typed
 * wrapper around that RPC.
 */
async function claimMeetingForSchedulerCall(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  schedulerCallId: string,
  meetingId: string,
  customerId: string,
  canonicalCallType: CallType,
  tier: "event_id" | "teams_link" | "schedule_match",
): Promise<boolean> {
  const { data: claimed, error } = await serviceRoleClient.rpc(
    "claim_scheduler_call_meeting",
    {
      p_scheduler_call_id: schedulerCallId,
      p_organization_id: organizationId,
      p_meeting_id: meetingId,
      p_customer_id: customerId,
      p_call_type: canonicalCallType,
    },
  );
  if (error) throw error;
  if (!claimed) return false;

  await logAuditEvent(serviceRoleClient, {
    organizationId,
    actorId: null,
    action: "meeting_customer.linked_auto",
    entityType: "meeting",
    entityId: meetingId,
    metadata: { customerId, source: "scheduler", tier },
  });

  return true;
}

/**
 * Tier 1 (exact teams_event_id) -> Tier 2 (normalized teams_link) -> Tier 3
 * (same AM + scheduled-time tolerance). Tier 4 — the existing attendee-
 * email fallback — is deliberately NOT called from here: it's
 * evaluateMeetingCustomerLinkage/reconcileOrganizationCustomerLinkage,
 * completely unchanged, run separately AFTER this (see
 * reconcileOrganizationSchedulerCalls's caller) — its own RESOLVED_STATUSES
 * check already skips anything this function just linked, so ordering
 * alone gives the right tier priority with no shared code path.
 */
async function attemptMeetingLinkage(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  schedulerCallId: string,
  ownerMembershipId: string,
  customerId: string,
  call: SchedulerCall,
): Promise<boolean> {
  const canonicalCallType = mapExternalCallType(call.externalType);

  if (call.teamsEventId) {
    const meetingId = await findMeetingIdByEventId(
      serviceRoleClient,
      organizationId,
      ownerMembershipId,
      call.amEmail,
      call.teamsEventId,
    );
    if (meetingId) {
      const linked = await claimMeetingForSchedulerCall(
        serviceRoleClient,
        organizationId,
        schedulerCallId,
        meetingId,
        customerId,
        canonicalCallType,
        "event_id",
      );
      if (linked) return true;
    }
  }

  const normalizedLink = normalizeTeamsLink(call.teamsLink);
  if (normalizedLink) {
    const meetingId = await findMeetingIdByTeamsLink(
      serviceRoleClient,
      organizationId,
      ownerMembershipId,
      normalizedLink,
    );
    if (meetingId) {
      const linked = await claimMeetingForSchedulerCall(
        serviceRoleClient,
        organizationId,
        schedulerCallId,
        meetingId,
        customerId,
        canonicalCallType,
        "teams_link",
      );
      if (linked) return true;
    }
  }

  const meetingId = await findMeetingIdByScheduleMatch(
    serviceRoleClient,
    organizationId,
    ownerMembershipId,
    call.scheduledAt,
  );
  if (meetingId) {
    return claimMeetingForSchedulerCall(
      serviceRoleClient,
      organizationId,
      schedulerCallId,
      meetingId,
      customerId,
      canonicalCallType,
      "schedule_match",
    );
  }

  return false;
}

export interface ReconcileSchedulerResult {
  amsProcessed: number;
  callsSeen: number;
  callsSkippedInvalid: number;
  customersCreated: number;
  customersOwnerReassigned: number;
  callsLinkedToMeetings: number;
  errors: { amEmail: string; error: string }[];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Per-AM bounded sync (revised M7A plan: "For each active managed AM").
 * Looping every active account_manager membership and querying the
 * scheduler with THAT membership's own work_email as am_email is also what
 * makes AM reassignment work correctly for free: a lead reassigned away
 * from AM A simply stops appearing in A's own filtered query and starts
 * appearing in B's — no separate "did ownership change" check is needed
 * up front, re-resolution happens naturally on every pass (see
 * reresolveCustomerOwner for the customer-level consequence of that).
 */
export async function reconcileOrganizationSchedulerCalls(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
  schedulerBaseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<ReconcileSchedulerResult> {
  const { data: memberships, error: membershipsError } = await serviceRoleClient
    .from("organization_memberships")
    .select("id, work_email, role_id")
    .eq("organization_id", organizationId)
    .eq("status", "active");
  if (membershipsError) throw membershipsError;

  const { data: amRole, error: amRoleError } = await serviceRoleClient
    .from("roles")
    .select("id")
    .is("organization_id", null)
    .eq("key", "account_manager")
    .maybeSingle();
  if (amRoleError) throw amRoleError;

  const managedAms = (memberships ?? []).filter(
    (m) => amRole && m.role_id === amRole.id,
  );

  const now = new Date();
  const from = isoDate(
    new Date(now.getTime() - RECONCILE_LOOKBACK_DAYS * 86_400_000),
  );
  const to = isoDate(
    new Date(now.getTime() + RECONCILE_LOOKAHEAD_DAYS * 86_400_000),
  );

  const result: ReconcileSchedulerResult = {
    amsProcessed: 0,
    callsSeen: 0,
    callsSkippedInvalid: 0,
    customersCreated: 0,
    customersOwnerReassigned: 0,
    callsLinkedToMeetings: 0,
    errors: [],
  };

  for (const am of managedAms) {
    const amEmail = am.work_email.toLowerCase();
    try {
      const { calls, skippedInvalidRows } = await listCalls(
        schedulerBaseUrl,
        { amEmail, from, to },
        fetchImpl,
      );
      result.amsProcessed += 1;
      result.callsSeen += calls.length;
      result.callsSkippedInvalid += skippedInvalidRows;

      for (const call of calls) {
        const ownerMembershipId = await resolveManagedAmMembership(
          serviceRoleClient,
          organizationId,
          call.amEmail,
        );
        if (!ownerMembershipId) continue;

        const {
          customerId,
          ownerMembershipId: existingOwner,
          created,
        } = await upsertCustomerForLead(serviceRoleClient, organizationId, {
          leadId: call.leadId,
          clientName: call.clientName,
          ownerMembershipId,
        });
        if (created) result.customersCreated += 1;

        await syncCustomerContact(
          serviceRoleClient,
          organizationId,
          customerId,
          call.clientEmail,
          call.clientName,
        );

        const upserted = await upsertSchedulerCallRow(
          serviceRoleClient,
          organizationId,
          customerId,
          ownerMembershipId,
          call,
        );

        const reassigned = await reresolveCustomerOwner(
          serviceRoleClient,
          organizationId,
          customerId,
          existingOwner,
        );
        if (reassigned) result.customersOwnerReassigned += 1;

        if (!upserted.meetingId) {
          const linked = await attemptMeetingLinkage(
            serviceRoleClient,
            organizationId,
            upserted.id,
            ownerMembershipId,
            customerId,
            call,
          );
          if (linked) result.callsLinkedToMeetings += 1;
        }
      }
    } catch (error) {
      result.errors.push({
        amEmail,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
