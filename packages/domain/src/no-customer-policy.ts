import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * No-customer policy threshold: notify manager after this many violations
 * within the lookback window. The AM is always notified for each occurrence.
 */
export const NO_CUSTOMER_REPEAT_THRESHOLD = 2;

/**
 * Lookback window (in days) for counting no-customer policy violations.
 */
export const NO_CUSTOMER_LOOKBACK_DAYS = 7;

/**
 * Policy violation reasons for when a meeting has bot+AM but no external customer.
 */
export type NoCustomerViolation = 
  | "no_customer_attendee"      // Bot + AM present, but zero external customer attendees
  | "customer_not_linked";      // Bot + AM present, but meeting.customer_id is null

export interface NoCustomerPolicyResult {
  isViolation: boolean;
  violationType: NoCustomerViolation | null;
  shouldNotifyAM: boolean;
  shouldNotifyManager: boolean;
  recentViolationCount: number;
}

/**
 * Detects when a meeting has the bot + AM present but no external customer attendee.
 * This is a waste of bot resources and should be tracked/reported.
 * 
 * Policy:
 * - Notify AM always (in-app notification or existing notification path)
 * - Notify manager only on repeat threshold (2+ violations in 7 days)
 * - Block Customer Truth / intelligence processing (same as integrity FAIL)
 * 
 * Returns null if the meeting is not yet completed or bot data is unavailable.
 */
export async function evaluateNoCustomerPolicy(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
): Promise<NoCustomerPolicyResult | null> {
  // Fetch meeting with bot job status
  const { data: meeting, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("id, organization_id, owner_membership_id, customer_id, lifecycle_status")
    .eq("id", meetingId)
    .single();
  if (meetingError) throw meetingError;

  // Only evaluate completed meetings
  if (meeting.lifecycle_status !== "completed") {
    return null;
  }

  // Check if bot was present (at least one completed bot job)
  const { data: completedBot, error: botError } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select("id, status")
    .eq("meeting_id", meetingId)
    .eq("organization_id", meeting.organization_id)
    .eq("status", "completed")
    .maybeSingle();
  if (botError) throw botError;

  // No bot = no policy evaluation needed
  if (!completedBot) {
    return null;
  }

  // Check for external customer attendees (participant_type != 'organizer' and not our own domain)
  const { data: attendees, error: attendeesError } = await serviceRoleClient
    .from("meeting_attendees")
    .select("email, participant_type, attended")
    .eq("meeting_id", meetingId);
  if (attendeesError) throw attendeesError;

  // Get internal email domains from organization memberships to identify external attendees
  const { data: memberships, error: membershipsError } = await serviceRoleClient
    .from("organization_memberships")
    .select("work_email")
    .eq("organization_id", meeting.organization_id)
    .limit(100); // Get a sample to extract domains
  if (membershipsError) throw membershipsError;

  const internalDomains = new Set(
    (memberships ?? [])
      .map((m) => m.work_email.split("@")[1]?.toLowerCase())
      .filter((d): d is string => Boolean(d))
  );

  // Check if there are any external attendees who actually attended
  const hasExternalCustomer = (attendees ?? []).some((attendee) => {
    if (!attendee.email) return false;
    if (!attendee.attended) return false; // Must have actually attended
    if (attendee.participant_type === "organizer") return false; // Organizer is the AM
    
    const domain = attendee.email.split("@")[1]?.toLowerCase();
    return domain && !internalDomains.has(domain);
  });

  let violationType: NoCustomerViolation | null = null;
  
  if (!hasExternalCustomer) {
    // Determine specific violation type
    if (!meeting.customer_id) {
      violationType = "customer_not_linked";
    } else {
      violationType = "no_customer_attendee";
    }
  }

  // If no violation, return early
  if (!violationType) {
    return {
      isViolation: false,
      violationType: null,
      shouldNotifyAM: false,
      shouldNotifyManager: false,
      recentViolationCount: 0,
    };
  }

  // Count recent violations for this AM to determine if manager should be notified
  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - NO_CUSTOMER_LOOKBACK_DAYS);

  // Only count violations if meeting has an owner (otherwise can't attribute to AM)
  if (!meeting.owner_membership_id) {
    return {
      isViolation: true,
      violationType,
      shouldNotifyAM: false,
      shouldNotifyManager: false,
      recentViolationCount: 0,
    };
  }

  // Count recent violations for this AM to determine manager notification threshold
  // For now, we count this meeting as violation #1. In production, this would query
  // a stored policy evaluation history table (e.g., meeting_policy_violations) to
  // count actual previous violations within the lookback window.
  const recentViolationCount = 1; // TODO: Query stored violation history from dedicated table

  const shouldNotifyManager = recentViolationCount >= NO_CUSTOMER_REPEAT_THRESHOLD;

  return {
    isViolation: true,
    violationType,
    shouldNotifyAM: true,
    shouldNotifyManager,
    recentViolationCount,
  };
}

/**
 * Determines if meeting intelligence processing should be blocked based on
 * no-customer policy evaluation. Block processing when bot+AM present but
 * no external customer attended (same as integrity FAIL).
 */
export function shouldBlockIntelligence(policyResult: NoCustomerPolicyResult | null): boolean {
  return policyResult?.isViolation ?? false;
}
