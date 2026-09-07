import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { evaluateMeetingPolicy } from "./meeting-policy";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

export interface RequestDoNotRecordInput {
  meetingId: string;
  organizationId: string;
  requestedByMembershipId: string;
  actorUserId: string;
  reason: string;
}

/**
 * AM-initiated. `supabase` must be the requester's OWN authenticated
 * client — RLS (recording_exemption_requests_insert_own) is what actually
 * enforces "only for a meeting you own", this function doesn't re-check
 * it. `serviceRoleClient` is only needed for the one write meetings RLS
 * doesn't allow an authenticated client to make directly (meetings writes
 * are service-role only, per M4's design).
 *
 * KNOWN DEFERRED ISSUE (Codex's M5 final review): the insert and the
 * meetings update below are two separate requests, not one transaction —
 * if the insert succeeds but the update fails, the request sits
 * 'requested' while the meeting is still 'pending' until the next
 * evaluation/review self-heals it. Same is true of reviewException's
 * multi-step writes. Real, but self-healing in the worst realistic case
 * and a systemic property of every multi-step Supabase-JS write in this
 * app, not unique to M5 — wrapping these in DB-side RPCs is a bigger
 * change deferred rather than taken on here.
 */
export async function requestDoNotRecord(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: RequestDoNotRecordInput,
): Promise<{ requestId: string }> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("A reason is required to request not to record.");
  }

  const { data: request, error } = await supabase
    .from("recording_exemption_requests")
    .insert({
      meeting_id: input.meetingId,
      organization_id: input.organizationId,
      requested_by: input.requestedByMembershipId,
      reason,
    })
    .select("id")
    .single();
  if (error) throw error;

  // Immediately visible, not waiting for the next evaluator run —
  // evaluateMeetingPolicy skips any meeting already at 'pending_exception',
  // which is exactly what keeps this sticky while a human reviews it.
  const { error: meetingError } = await serviceRoleClient
    .from("meetings")
    .update({ eligibility_status: "pending_exception" })
    .eq("id", input.meetingId);
  if (meetingError) throw meetingError;

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: "recording_exception.requested",
    entityType: "recording_exemption_request",
    entityId: request.id,
    metadata: { meetingId: input.meetingId, reason },
  });

  return { requestId: request.id };
}

export interface ReviewExceptionInput {
  requestId: string;
  organizationId: string;
  reviewerMembershipId: string;
  actorUserId: string;
  decision: "approved" | "rejected";
  reviewNotes?: string;
}

/**
 * Manager/Senior Manager/Admin. `supabase` must be the reviewer's OWN
 * authenticated client — RLS (recording_exemption_requests_update_review,
 * using private.is_manager_of) is the actual reviewer-scope enforcement,
 * and the DB trigger (validate_exemption_status_transition) is the actual
 * "no re-reviewing a decided request" enforcement. This function doesn't
 * duplicate either check — it relies on both failing loudly (a thrown
 * Postgres error) if either is violated.
 *
 * Approving or rejecting both just re-run evaluateMeetingPolicy rather
 * than special-casing the resulting eligibility_status here — approval
 * makes the approved_exemption rule fire on the next evaluation,
 * rejection means it won't, and every other rule still applies exactly
 * as it would have. One decision function, not two.
 */
export async function reviewException(
  supabase: AppSupabaseClient,
  serviceRoleClient: AppSupabaseClient,
  input: ReviewExceptionInput,
): Promise<void> {
  const { data: request, error } = await supabase
    .from("recording_exemption_requests")
    .update({
      status: input.decision,
      reviewed_by: input.reviewerMembershipId,
      reviewed_at: new Date().toISOString(),
      review_notes: input.reviewNotes ?? null,
    })
    .eq("id", input.requestId)
    .select("meeting_id")
    .single();
  if (error) throw error;

  // Clear the 'pending_exception' sticky guard before re-evaluating —
  // otherwise evaluateMeetingPolicy would skip this meeting right back
  // (see its own doc comment).
  const { error: resetError } = await serviceRoleClient
    .from("meetings")
    .update({ eligibility_status: "pending" })
    .eq("id", request.meeting_id);
  if (resetError) throw resetError;

  await evaluateMeetingPolicy(serviceRoleClient, request.meeting_id);

  await logAuditEvent(supabase, {
    organizationId: input.organizationId,
    actorId: input.actorUserId,
    action: input.decision === "approved" ? "recording_exception.approved" : "recording_exception.rejected",
    entityType: "recording_exemption_request",
    entityId: input.requestId,
    metadata: { meetingId: request.meeting_id, reviewNotes: input.reviewNotes ?? null },
  });
}

/**
 * A pending request whose meeting was cancelled (M4's dedupe/
 * reconciliation) has nothing left to decide — cancel it rather than
 * leaving it dangling forever, and audit that it happened. Service-role
 * only, no authenticated human actor (actorId: null — audit_events.actor_id
 * is nullable for exactly this kind of system-triggered row).
 */
async function cancelExceptionsForCancelledMeetings(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<number> {
  const { data: requested, error } = await serviceRoleClient
    .from("recording_exemption_requests")
    .select("id, meeting_id")
    .eq("organization_id", organizationId)
    .eq("status", "requested");
  if (error) throw error;

  let cancelledCount = 0;
  for (const request of requested ?? []) {
    // Explicit organization_id filter, not just id — service_role bypasses
    // RLS entirely, so this function is its own org boundary (Codex's M5
    // final review: a request row's own organization_id, already
    // org-scoped above, must never be trusted to imply its meeting is in
    // the same org without also checking).
    const { data: meeting, error: meetingError } = await serviceRoleClient
      .from("meetings")
      .select("lifecycle_status")
      .eq("id", request.meeting_id)
      .eq("organization_id", organizationId)
      .single();
    if (meetingError) throw meetingError;
    if (meeting.lifecycle_status !== "cancelled") continue;

    const { error: updateError } = await serviceRoleClient
      .from("recording_exemption_requests")
      .update({ status: "cancelled", reviewed_at: new Date().toISOString() })
      .eq("id", request.id)
      .eq("organization_id", organizationId);
    if (updateError) throw updateError;

    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "recording_exception.cancelled_meeting_cancelled",
      entityType: "recording_exemption_request",
      entityId: request.id,
      metadata: { meetingId: request.meeting_id },
    });

    cancelledCount += 1;
  }
  return cancelledCount;
}

/**
 * PRD §10, step 6: "Unresolved by cutoff → organization-configured
 * default applies." Cutoff is computed dynamically against the meeting's
 * CURRENT scheduled_start on every run — deliberately never cached — so
 * a reschedule can never leave a stale cutoff behind.
 */
async function resolveCutoffExceptions(serviceRoleClient: AppSupabaseClient, organizationId: string): Promise<number> {
  const { data: policySet, error: policySetError } = await serviceRoleClient
    .from("meeting_policy_sets")
    .select("cutoff_minutes_before_start")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (policySetError) throw policySetError;
  if (!policySet) return 0;

  const { data: requested, error } = await serviceRoleClient
    .from("recording_exemption_requests")
    .select("id, meeting_id")
    .eq("organization_id", organizationId)
    .eq("status", "requested");
  if (error) throw error;

  const cutoffMs = policySet.cutoff_minutes_before_start * 60 * 1000;
  let resolvedCount = 0;

  for (const request of requested ?? []) {
    // Explicit organization_id filter on every meetings read/write here —
    // same reasoning as cancelExceptionsForCancelledMeetings above.
    const { data: meeting, error: meetingError } = await serviceRoleClient
      .from("meetings")
      .select("scheduled_start, lifecycle_status")
      .eq("id", request.meeting_id)
      .eq("organization_id", organizationId)
      .single();
    if (meetingError) throw meetingError;
    // A cancelled meeting's pending request is cancelExceptionsForCancelledMeetings's job, not this one's.
    if (meeting.lifecycle_status === "cancelled") continue;

    const cutoffAt = new Date(meeting.scheduled_start).getTime() - cutoffMs;
    if (Date.now() < cutoffAt) continue;

    const { error: updateError } = await serviceRoleClient
      .from("recording_exemption_requests")
      .update({ status: "expired", reviewed_at: new Date().toISOString() })
      .eq("id", request.id)
      .eq("organization_id", organizationId);
    if (updateError) throw updateError;

    const { error: resetError } = await serviceRoleClient
      .from("meetings")
      .update({ eligibility_status: "pending" })
      .eq("id", request.meeting_id)
      .eq("organization_id", organizationId);
    if (resetError) throw resetError;

    await evaluateMeetingPolicy(serviceRoleClient, request.meeting_id);

    await logAuditEvent(serviceRoleClient, {
      organizationId,
      actorId: null,
      action: "recording_exception.expired_at_cutoff",
      entityType: "recording_exemption_request",
      entityId: request.id,
      metadata: { meetingId: request.meeting_id },
    });

    resolvedCount += 1;
  }

  return resolvedCount;
}

export interface ExceptionMaintenanceResult {
  cancelledForCancelledMeetings: number;
  resolvedAtCutoff: number;
}

/** Callable on demand via an internal route — same shape as M4's reconciliation, no scheduler yet (M16 concern). */
export async function runExceptionMaintenance(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<ExceptionMaintenanceResult> {
  const cancelledForCancelledMeetings = await cancelExceptionsForCancelledMeetings(serviceRoleClient, organizationId);
  const resolvedAtCutoff = await resolveCutoffExceptions(serviceRoleClient, organizationId);
  return { cancelledForCancelledMeetings, resolvedAtCutoff };
}
