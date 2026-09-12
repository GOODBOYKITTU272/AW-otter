import { getCurrentMembership } from "@applywizz/auth";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { PolicyEditor } from "./policy-editor";

const RULE_LABELS: Record<string, string> = {
  organization_disabled: "Organization disabled",
  employee_mi_disabled: "Employee Meeting Intelligence disabled",
  unsupported_mechanism: "Unsupported meeting mechanism (non-Teams)",
  admin_exclusion: "Admin exclusion",
  approved_exemption: "Approved do-not-record exemption",
  sensitive_internal: "Internal-only meeting",
  role_team: "Role / team",
  external_client: "External client attendee",
  org_default: "Organization default",
};

export default async function AdminPoliciesPage() {
  await requireRole(["admin"]);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);

  const { data: policySet, error: policySetError } = await supabase
    .from("meeting_policy_sets")
    .select("id, name, default_decision, cutoff_minutes_before_start, bot_dispatch_lead_seconds")
    .eq("organization_id", membership.organizationId)
    .single();
  if (policySetError) throw policySetError;

  const { data: rules, error: rulesError } = await supabase
    .from("meeting_policy_rules")
    .select("id, rule_type, enabled, reason_code")
    .eq("policy_set_id", policySet.id)
    .order("rule_type");
  if (rulesError) throw rulesError;

  return (
    <main className="flex flex-1 flex-col gap-8 p-8 max-w-7xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E]">Policies</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Recording eligibility rules, bot dispatch timing, and default decisions. Controls which
          meetings Echo automatically records and when bots join.
        </p>
      </div>

      <PolicyEditor
        policySet={policySet}
        rules={rules.map((rule) => ({ ...rule, label: RULE_LABELS[rule.rule_type] ?? rule.rule_type }))}
      />
    </main>
  );
}
