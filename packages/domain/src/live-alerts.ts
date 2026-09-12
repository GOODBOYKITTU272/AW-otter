import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { recordIncident } from "./operational-incidents";

export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * Phase-1 live alerts for Apply Wizz Echo: notify AM + Manager when bot is
 * stuck in lobby or when customer is missing after meeting start.
 */

/** Lobby waiting threshold (seconds): alert after bot waits this long */
export const LOBBY_ALERT_THRESHOLD_SECONDS = 75; // ~60-90s, using 75s midpoint

/** Customer missing warning threshold (minutes): notify after this long */
export const CUSTOMER_MISSING_WARN_MINUTES = 10;

/** Customer missing escalation threshold (minutes): escalate after this long */
export const CUSTOMER_MISSING_ESCALATE_MINUTES = 15;

export type AlertType =
  | "bot_lobby_stuck"
  | "customer_missing_warn"
  | "customer_missing_escalate";

export interface AlertNotification {
  meetingId: string;
  organizationId: string;
  alertType: AlertType;
  amMembershipId: string | null;
  managerMembershipId: string | null;
  message: string;
}

/**
 * Resolves the manager membership ID for a given AM membership ID.
 * Returns null if the AM has no manager assigned.
 */
async function getManagerMembershipId(
  serviceRoleClient: AppSupabaseClient,
  amMembershipId: string,
): Promise<string | null> {
  const { data, error } = await serviceRoleClient
    .from("organization_memberships")
    .select("manager_membership_id")
    .eq("id", amMembershipId)
    .maybeSingle();
  if (error) throw error;
  return data?.manager_membership_id ?? null;
}

/**
 * Checks for bots stuck in Teams lobby (lobby_waiting_since older than threshold).
 * Returns alerts that should be sent to AM + Manager.
 */
export async function detectLobbyAlerts(
  serviceRoleClient: AppSupabaseClient,
): Promise<AlertNotification[]> {
  const thresholdTime = new Date(
    Date.now() - LOBBY_ALERT_THRESHOLD_SECONDS * 1000,
  );

  // Find bot jobs stuck in lobby beyond threshold
  const { data: stuckBots, error } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select(
      "id, meeting_id, organization_id, lobby_waiting_since, last_raw_status",
    )
    .not("lobby_waiting_since", "is", null)
    .lt("lobby_waiting_since", thresholdTime.toISOString())
    .in("status", ["scheduled", "joining"]);

  if (error) throw error;
  if (!stuckBots || stuckBots.length === 0) return [];

  // Get meeting details to resolve AM (owner)
  const meetingIds = stuckBots.map((b) => b.meeting_id);
  const { data: meetings, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("id, organization_id, owner_membership_id, title")
    .in("id", meetingIds);

  if (meetingError) throw meetingError;

  const meetingById = new Map(meetings?.map((m) => [m.id, m]) ?? []);

  const alerts: AlertNotification[] = [];

  for (const bot of stuckBots) {
    const meeting = meetingById.get(bot.meeting_id);
    if (!meeting || !meeting.owner_membership_id) continue;

    // Resolve manager for this AM
    const managerMembershipId = await getManagerMembershipId(
      serviceRoleClient,
      meeting.owner_membership_id,
    );

    alerts.push({
      meetingId: meeting.id,
      organizationId: meeting.organization_id,
      alertType: "bot_lobby_stuck",
      amMembershipId: meeting.owner_membership_id,
      managerMembershipId,
      message: `Echo bot stuck in Teams lobby for "${meeting.title}". Bot has been waiting for admission since ${new Date(bot.lobby_waiting_since!).toLocaleTimeString()}. Please manually admit the bot or check meeting permissions.`,
    });
  }

  return alerts;
}

/**
 * Checks for meetings where customer is missing after bot joined or AM is present.
 * Returns alerts for both warning (10 min) and escalation (15 min) thresholds.
 */
export async function detectCustomerMissingAlerts(
  serviceRoleClient: AppSupabaseClient,
): Promise<AlertNotification[]> {
  const now = Date.now();

  // Find meetings that have started and have a bot that joined
  const { data: activeMeetings, error } = await serviceRoleClient
    .from("meetings")
    .select("id, organization_id, owner_membership_id, title, scheduled_start")
    .eq("lifecycle_status", "upcoming")
    .lt("scheduled_start", new Date(now).toISOString());

  if (error) throw error;
  if (!activeMeetings || activeMeetings.length === 0) return [];

  const meetingIds = activeMeetings.map((m) => m.id);

  // Get bot jobs that are joined (actively recording)
  const { data: botJobs, error: botError } = await serviceRoleClient
    .from("meeting_bot_jobs")
    .select("meeting_id, joined_at")
    .in("meeting_id", meetingIds)
    .eq("status", "joined")
    .not("joined_at", "is", null);

  if (botError) throw botError;

  const botJoinedByMeeting = new Map(
    botJobs?.map((b) => [b.meeting_id, b.joined_at]) ?? [],
  );

  // Get attendees for these meetings
  const { data: attendees, error: attendeesError } = await serviceRoleClient
    .from("meeting_attendees")
    .select("meeting_id, email, participant_type, attended")
    .in("meeting_id", meetingIds);

  if (attendeesError) throw attendeesError;

  // Group attendees by meeting
  const attendeesByMeeting = new Map<string, typeof attendees>();
  for (const attendee of attendees ?? []) {
    const list = attendeesByMeeting.get(attendee.meeting_id) ?? [];
    list.push(attendee);
    attendeesByMeeting.set(attendee.meeting_id, list);
  }

  // Get internal email domains to identify external attendees
  const orgIds = [...new Set(activeMeetings.map((m) => m.organization_id))];
  const { data: memberships, error: membershipsError } = await serviceRoleClient
    .from("organization_memberships")
    .select("organization_id, work_email")
    .in("organization_id", orgIds)
    .limit(500);

  if (membershipsError) throw membershipsError;

  // Build internal domain sets per org
  const internalDomainsByOrg = new Map<string, Set<string>>();
  for (const m of memberships ?? []) {
    const domain = m.work_email.split("@")[1]?.toLowerCase();
    if (!domain) continue;
    const domains = internalDomainsByOrg.get(m.organization_id) ?? new Set();
    domains.add(domain);
    internalDomainsByOrg.set(m.organization_id, domains);
  }

  const alerts: AlertNotification[] = [];

  for (const meeting of activeMeetings) {
    // Skip if AM is not assigned
    if (!meeting.owner_membership_id) continue;

    // Check if bot has joined (if not, we don't alert yet)
    const botJoinedAt = botJoinedByMeeting.get(meeting.id);
    if (!botJoinedAt) {
      // Bot hasn't joined yet, use meeting start time as reference
      // Only alert if meeting start time has passed by threshold
      const meetingStartTime = new Date(meeting.scheduled_start).getTime();
      const minutesSinceStart = (now - meetingStartTime) / (60 * 1000);
      if (minutesSinceStart < CUSTOMER_MISSING_WARN_MINUTES) continue;
    }

    // Check for external customer attendees
    const meetingAttendees = attendeesByMeeting.get(meeting.id) ?? [];
    const internalDomains = internalDomainsByOrg.get(meeting.organization_id);

    const hasExternalCustomer = meetingAttendees.some((attendee) => {
      if (!attendee.email) return false;
      if (attendee.participant_type === "organizer") return false; // Organizer is the AM

      const domain = attendee.email.split("@")[1]?.toLowerCase();
      const isExternal = domain && internalDomains && !internalDomains.has(domain);
      
      // Consider external customer present if they attended
      return isExternal && attendee.attended;
    });

    // If external customer is present or attended, no alert needed
    if (hasExternalCustomer) continue;

    // Determine which threshold we've crossed
    const referenceTime = botJoinedAt
      ? new Date(botJoinedAt).getTime()
      : new Date(meeting.scheduled_start).getTime();
    const minutesElapsed = (now - referenceTime) / (60 * 1000);

    let alertType: AlertType | null = null;
    let message = "";

    if (minutesElapsed >= CUSTOMER_MISSING_ESCALATE_MINUTES) {
      alertType = "customer_missing_escalate";
      message = `ESCALATION: Customer still missing after ${CUSTOMER_MISSING_ESCALATE_MINUTES} minutes for "${meeting.title}". No external customer attendee has joined. Consider ending the meeting or checking if customer was notified.`;
    } else if (minutesElapsed >= CUSTOMER_MISSING_WARN_MINUTES) {
      alertType = "customer_missing_warn";
      message = `Customer missing for ${CUSTOMER_MISSING_WARN_MINUTES} minutes in "${meeting.title}". No external customer attendee has joined yet. Bot is recording but customer may not be aware of the meeting.`;
    }

    if (alertType) {
      // Resolve manager for this AM
      const managerMembershipId = await getManagerMembershipId(
        serviceRoleClient,
        meeting.owner_membership_id,
      );

      alerts.push({
        meetingId: meeting.id,
        organizationId: meeting.organization_id,
        alertType,
        amMembershipId: meeting.owner_membership_id,
        managerMembershipId,
        message,
      });
    }
  }

  return alerts;
}

/**
 * Records an alert as an operational incident (for deduplication and visibility).
 * Returns true if this is a new alert (not a duplicate), false if already recorded.
 */
async function recordAlertIncident(
  serviceRoleClient: AppSupabaseClient,
  alert: AlertNotification,
): Promise<boolean> {
  // Check if this alert was already recorded as an open incident
  const { data: existing, error: checkError } = await serviceRoleClient
    .from("operational_incidents")
    .select("id, occurrence_count")
    .eq("organization_id", alert.organizationId)
    .eq("queue", "live_alerts")
    .eq("entity_id", alert.meetingId)
    .eq("incident_type", alert.alertType)
    .is("resolved_at", null)
    .maybeSingle();

  if (checkError) throw checkError;

  // If incident already exists, it's a duplicate - don't send alert again
  if (existing) return false;

  // Record as new incident
  await recordIncident(serviceRoleClient, {
    organizationId: alert.organizationId,
    queue: "live_alerts",
    entityId: alert.meetingId,
    incidentType: alert.alertType,
    severity: alert.alertType === "customer_missing_escalate" ? "critical" : "warning",
    reason: alert.alertType,
    meetingId: alert.meetingId,
  });

  return true;
}

/**
 * Sends alert notifications to AM and Manager via operational_incidents.
 * The incident record serves as a durable in-app notification - AM Home and
 * Manager overview pages query open incidents for their meetings to display
 * live alerts.
 * 
 * No email delivery yet - operational_incidents table is the single source of
 * truth for alert visibility.
 */
async function sendAlertNotifications(
  _serviceRoleClient: AppSupabaseClient,
  _alert: AlertNotification,
): Promise<void> {
  // Notification delivery is handled by operational_incidents record creation
  // in recordAlertIncident(). AM Home (/home) and Manager overview
  // (/manager/overview) query operational_incidents to show live alerts.
  // No additional action needed here.
}

export interface ProcessAlertsResult {
  lobbyAlerts: number;
  customerMissingAlerts: number;
  totalSent: number;
}

/**
 * Live alert for display in AM/Manager UIs.
 */
export interface LiveAlert {
  id: string;
  alertType: AlertType;
  meetingId: string;
  meetingTitle: string | null;
  message: string;
  severity: "warning" | "critical";
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
}

/**
 * Fetches open live alerts for meetings owned by the given membership.
 * Used by AM Home to show alerts for their own meetings.
 */
export async function getAMLiveAlerts(
  supabase: AppSupabaseClient,
  membershipId: string,
): Promise<LiveAlert[]> {
  // Get meetings owned by this AM
  const { data: meetings, error: meetingsError } = await supabase
    .from("meetings")
    .select("id, title")
    .eq("owner_membership_id", membershipId);

  if (meetingsError) throw meetingsError;
  if (!meetings || meetings.length === 0) return [];

  const meetingIds = meetings.map((m) => m.id);
  const meetingTitleById = new Map(meetings.map((m) => [m.id, m.title]));

  // Get open live alert incidents for these meetings
  const { data: incidents, error: incidentsError } = await supabase
    .from("operational_incidents")
    .select("id, meeting_id, incident_type, reason, severity, occurrence_count, first_seen_at, last_seen_at")
    .eq("queue", "live_alerts")
    .in("meeting_id", meetingIds)
    .is("resolved_at", null)
    .order("severity", { ascending: false })
    .order("last_seen_at", { ascending: false });

  if (incidentsError) throw incidentsError;

  return (incidents ?? []).map((i) => ({
    id: i.id,
    alertType: i.incident_type as AlertType,
    meetingId: i.meeting_id!,
    meetingTitle: meetingTitleById.get(i.meeting_id!) ?? null,
    message: formatAlertMessage(i.incident_type as AlertType, meetingTitleById.get(i.meeting_id!)),
    severity: i.severity as "warning" | "critical",
    firstSeenAt: i.first_seen_at,
    lastSeenAt: i.last_seen_at,
    occurrenceCount: i.occurrence_count,
  }));
}

/**
 * Fetches open live alerts for meetings owned by direct reports of the given manager.
 * Used by Manager overview to show alerts across their team.
 */
export async function getManagerLiveAlerts(
  supabase: AppSupabaseClient,
  managerMembershipId: string,
): Promise<Array<LiveAlert & { amName: string; amMembershipId: string }>> {
  // Get direct reports
  const { data: reports, error: reportsError } = await supabase
    .from("organization_memberships")
    .select("id, display_name")
    .eq("manager_membership_id", managerMembershipId);

  if (reportsError) throw reportsError;
  if (!reports || reports.length === 0) return [];

  const reportIds = reports.map((r) => r.id);
  const reportNameById = new Map(reports.map((r) => [r.id, r.display_name]));

  // Get meetings owned by these AMs
  const { data: meetings, error: meetingsError } = await supabase
    .from("meetings")
    .select("id, title, owner_membership_id")
    .in("owner_membership_id", reportIds);

  if (meetingsError) throw meetingsError;
  if (!meetings || meetings.length === 0) return [];

  const meetingIds = meetings.map((m) => m.id);
  const meetingById = new Map(meetings.map((m) => [m.id, m]));

  // Get open live alert incidents for these meetings
  const { data: incidents, error: incidentsError } = await supabase
    .from("operational_incidents")
    .select("id, meeting_id, incident_type, reason, severity, occurrence_count, first_seen_at, last_seen_at")
    .eq("queue", "live_alerts")
    .in("meeting_id", meetingIds)
    .is("resolved_at", null)
    .order("severity", { ascending: false })
    .order("last_seen_at", { ascending: false });

  if (incidentsError) throw incidentsError;

  return (incidents ?? [])
    .filter((i) => i.meeting_id && meetingById.has(i.meeting_id))
    .map((i) => {
      const meeting = meetingById.get(i.meeting_id!)!;
      return {
        id: i.id,
        alertType: i.incident_type as AlertType,
        meetingId: i.meeting_id!,
        meetingTitle: meeting.title ?? null,
        message: formatAlertMessage(i.incident_type as AlertType, meeting.title),
        severity: i.severity as "warning" | "critical",
        firstSeenAt: i.first_seen_at,
        lastSeenAt: i.last_seen_at,
        occurrenceCount: i.occurrence_count,
        amName: reportNameById.get(meeting.owner_membership_id!) ?? "Unknown",
        amMembershipId: meeting.owner_membership_id!,
      };
    });
}

function formatAlertMessage(alertType: AlertType, meetingTitle: string | null | undefined): string {
  const title = meetingTitle ?? "Meeting";
  switch (alertType) {
    case "bot_lobby_stuck":
      return `Echo bot stuck in Teams lobby for "${title}". Please admit the bot.`;
    case "customer_missing_warn":
      return `Customer missing for 10+ minutes in "${title}". No external attendee has joined.`;
    case "customer_missing_escalate":
      return `ESCALATION: Customer still missing after 15+ minutes in "${title}".`;
    default:
      return `Alert for "${title}"`;
  }
}

/**
 * Main entry point: detects and processes all live alerts for active meetings.
 * Checks for lobby waiting and customer missing, records incidents, and sends
 * notifications to AM + Manager. Deduplicates via operational_incidents.
 */
export async function processLiveAlerts(
  serviceRoleClient: AppSupabaseClient,
): Promise<ProcessAlertsResult> {
  const [lobbyAlerts, customerMissingAlerts] = await Promise.all([
    detectLobbyAlerts(serviceRoleClient),
    detectCustomerMissingAlerts(serviceRoleClient),
  ]);

  let totalSent = 0;

  // Process lobby alerts
  for (const alert of lobbyAlerts) {
    const isNew = await recordAlertIncident(serviceRoleClient, alert);
    if (isNew) {
      await sendAlertNotifications(serviceRoleClient, alert);
      totalSent += 1;
    }
  }

  // Process customer missing alerts
  for (const alert of customerMissingAlerts) {
    const isNew = await recordAlertIncident(serviceRoleClient, alert);
    if (isNew) {
      await sendAlertNotifications(serviceRoleClient, alert);
      totalSent += 1;
    }
  }

  return {
    lobbyAlerts: lobbyAlerts.length,
    customerMissingAlerts: customerMissingAlerts.length,
    totalSent,
  };
}
