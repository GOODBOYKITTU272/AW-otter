import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

type MeetingEligibility = Database["public"]["Enums"]["meeting_eligibility"];

interface PolicyRuleRow {
  enabled: boolean;
  params: unknown;
  reason_code: string;
}

export interface EvaluationResult {
  decision: MeetingEligibility;
  ruleType: string | null;
  reasonCode: string;
}

/**
 * The fixed priority order (TRD §6, items 8-16) — trusted application
 * code, not admin-editable arbitrary logic (M5 design decision, reviewed
 * by Codex: "use fixed application code for TRD priority 8-16... avoid
 * generic JSON predicates until admins need rules the fixed list cannot
 * name"). meeting_policy_rules rows are simple enable/disable toggles +
 * small params for each of these fixed steps, not a condition language.
 *
 * role_team never fires in V1 (no team-selection data exists to check
 * against yet — ships as an inert, seeded toggle so a later milestone can
 * activate it without a new migration). admin_exclusion is seeded for
 * schema completeness per the locked blueprint but is never checked here
 * directly — blueprint priorities #11 ("explicit admin exclusion") and
 * #12 ("approved recording exemption") are merged into the one real
 * mechanism, approved_exemption (an approved recording_exemption_requests
 * row, whoever initiated it) — a deliberate, flagged V1 simplification.
 */
export async function evaluateMeetingPolicy(
  serviceRoleClient: AppSupabaseClient,
  meetingId: string,
): Promise<EvaluationResult | null> {
  const { data: meeting, error: meetingError } = await serviceRoleClient
    .from("meetings")
    .select("organization_id, owner_membership_id, meeting_type, meeting_url, lifecycle_status, eligibility_status")
    .eq("id", meetingId)
    .single();
  if (meetingError) throw meetingError;

  // Cancelled meetings are never (re-)evaluated — there is no eligibility
  // value in the locked enum for "cancelled", and a cancelled meeting was
  // never going to be captured regardless of what the policy would have
  // said.
  if (meeting.lifecycle_status === "cancelled") return null;

  // A meeting mid-review (an AM's request is 'requested', not yet
  // decided) is never touched by evaluation — only reviewException or
  // resolveCutoffExceptions may move it forward. This is what actually
  // makes 'pending_exception' sticky against re-evaluation.
  if (meeting.eligibility_status === "pending_exception") return null;

  const { data: policySet, error: policySetError } = await serviceRoleClient
    .from("meeting_policy_sets")
    .select("id, default_decision")
    .eq("organization_id", meeting.organization_id)
    .maybeSingle();
  if (policySetError) throw policySetError;

  const record = async (result: EvaluationResult): Promise<EvaluationResult> => {
    const { error: updateError } = await serviceRoleClient
      .from("meetings")
      .update({ eligibility_status: result.decision })
      .eq("id", meetingId);
    if (updateError) throw updateError;

    const { error: decisionError } = await serviceRoleClient.from("meeting_policy_decisions").insert({
      meeting_id: meetingId,
      organization_id: meeting.organization_id,
      policy_set_id: policySet?.id ?? null,
      decision: result.decision,
      rule_type: result.ruleType,
      reason_code: result.reasonCode,
    });
    if (decisionError) throw decisionError;

    return result;
  };

  // Defensive — the bootstrap trigger guarantees every org has a policy
  // set, but don't silently default a decision if that invariant somehow
  // didn't hold.
  if (!policySet) {
    return record({ decision: "pending", ruleType: null, reasonCode: "No policy configured for this organization" });
  }

  // A meeting not yet attributed to a known ApplyWizz employee is
  // genuinely incomplete state, not a decision — 'pending' is the enum's
  // own "not yet decided" value.
  if (!meeting.owner_membership_id) {
    return record({ decision: "pending", ruleType: null, reasonCode: "Awaiting meeting owner attribution" });
  }

  const { data: rules, error: rulesError } = await serviceRoleClient
    .from("meeting_policy_rules")
    .select("rule_type, enabled, params, reason_code")
    .eq("policy_set_id", policySet.id);
  if (rulesError) throw rulesError;

  const ruleByType = new Map<string, PolicyRuleRow>();
  for (const rule of rules ?? []) {
    ruleByType.set(rule.rule_type, { enabled: rule.enabled, params: rule.params, reason_code: rule.reason_code });
  }

  const [{ data: organization, error: organizationError }, { data: owner, error: ownerError }] = await Promise.all([
    serviceRoleClient.from("organizations").select("status, email_domain").eq("id", meeting.organization_id).single(),
    serviceRoleClient
      .from("organization_memberships")
      .select("meeting_ai_enabled")
      .eq("id", meeting.owner_membership_id)
      .single(),
  ]);
  if (organizationError) throw organizationError;
  if (ownerError) throw ownerError;

  const organizationDisabled = ruleByType.get("organization_disabled");
  if (organizationDisabled?.enabled && organization.status !== "active") {
    return record({ decision: "exclude", ruleType: "organization_disabled", reasonCode: organizationDisabled.reason_code });
  }

  const employeeMiDisabled = ruleByType.get("employee_mi_disabled");
  if (employeeMiDisabled?.enabled && !owner.meeting_ai_enabled) {
    return record({ decision: "exclude", ruleType: "employee_mi_disabled", reasonCode: employeeMiDisabled.reason_code });
  }

  const unsupportedMechanism = ruleByType.get("unsupported_mechanism");
  if (unsupportedMechanism?.enabled && (meeting.meeting_type !== "teams" || !meeting.meeting_url)) {
    return record({ decision: "unsupported", ruleType: "unsupported_mechanism", reasonCode: unsupportedMechanism.reason_code });
  }

  const approvedExemption = ruleByType.get("approved_exemption");
  if (approvedExemption?.enabled) {
    const { data: exemption, error: exemptionError } = await serviceRoleClient
      .from("recording_exemption_requests")
      .select("id")
      .eq("meeting_id", meetingId)
      .eq("status", "approved")
      .maybeSingle();
    if (exemptionError) throw exemptionError;
    if (exemption) {
      return record({ decision: "exclude", ruleType: "approved_exemption", reasonCode: approvedExemption.reason_code });
    }
  }

  const sensitiveInternal = ruleByType.get("sensitive_internal");
  const externalClient = ruleByType.get("external_client");
  if ((sensitiveInternal?.enabled || externalClient?.enabled) && organization.email_domain) {
    const { data: attendees, error: attendeesError } = await serviceRoleClient
      .from("meeting_attendees")
      .select("email")
      .eq("meeting_id", meetingId);
    if (attendeesError) throw attendeesError;

    const domainSuffix = `@${organization.email_domain}`.toLowerCase();
    const emails = (attendees ?? []).map((a) => (a.email ?? "").toLowerCase()).filter((e) => e.length > 0);
    const hasExternal = emails.some((email) => !email.endsWith(domainSuffix));
    const allInternal = emails.length > 0 && emails.every((email) => email.endsWith(domainSuffix));

    if (sensitiveInternal?.enabled && allInternal) {
      return record({ decision: "exclude", ruleType: "sensitive_internal", reasonCode: sensitiveInternal.reason_code });
    }
    if (externalClient?.enabled && hasExternal) {
      const params = externalClient.params as { decision?: MeetingEligibility } | null;
      return record({
        decision: params?.decision ?? "record",
        ruleType: "external_client",
        reasonCode: externalClient.reason_code,
      });
    }
  }

  // role_team is intentionally never checked — inert in V1, see module doc.

  const orgDefault = ruleByType.get("org_default");
  return record({
    decision: policySet.default_decision,
    ruleType: "org_default",
    reasonCode: orgDefault?.reason_code ?? "Organization default policy applied",
  });
}

export interface EvaluateOrganizationResult {
  meetingsEvaluated: number;
  decisions: Record<string, number>;
}

/**
 * Decoupled batch evaluator — callable on demand via an internal route,
 * same shape as M4's reconciliation. Deliberately NOT wired into M4's
 * upsertCanonicalMeeting (Codex's review: "touching M4's
 * upsertCanonicalMeeting just to call policy evaluation is coupling
 * without much payoff" — pending is a valid, visible "not yet evaluated"
 * state, not a correctness blocker).
 */
export async function evaluateOrganizationMeetings(
  serviceRoleClient: AppSupabaseClient,
  organizationId: string,
): Promise<EvaluateOrganizationResult> {
  const { data: meetings, error } = await serviceRoleClient
    .from("meetings")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("lifecycle_status", "upcoming");
  if (error) throw error;

  const decisions: Record<string, number> = {};
  let meetingsEvaluated = 0;

  for (const meeting of meetings ?? []) {
    const result = await evaluateMeetingPolicy(serviceRoleClient, meeting.id);
    if (!result) continue;
    meetingsEvaluated += 1;
    decisions[result.decision] = (decisions[result.decision] ?? 0) + 1;
  }

  return { meetingsEvaluated, decisions };
}
