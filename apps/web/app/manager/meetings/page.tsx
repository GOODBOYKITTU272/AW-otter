import Link from "next/link";
import { RoleShell } from "@/components/role-shell";
import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const RECAP_TONE: Record<string, BadgeTone> = {
  approved: "success",
  ready_for_review: "info",
  draft: "warning",
};

const INTEGRITY_TONE: Record<string, BadgeTone> = {
  good: "success",
  review_recommended: "warning",
  poor_audio: "critical",
  suspected_background_media: "warning",
  insufficient_speech: "neutral",
  transcription_unreliable: "critical",
};

const INTEGRITY_LABELS: Record<string, string> = {
  good: "Clean Audio",
  review_recommended: "Review Recommended",
  poor_audio: "Poor Audio",
  suspected_background_media: "Background Media",
  insufficient_speech: "Low Speech",
  transcription_unreliable: "Unreliable",
};

export default async function ManagerMeetingsPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();

  const { data: teamMeetings } = await supabase
    .from("meetings")
    .select("id, title, call_type, scheduled_start, owner_membership_id, customer_id")
    .order("scheduled_start", { ascending: false })
    .limit(15);

  const meetings = teamMeetings ?? [];
  const meetingIds = meetings.map((m) => m.id);

  const ownerIds = Array.from(
    new Set(meetings.map((m) => m.owner_membership_id).filter((v): v is string => Boolean(v))),
  );
  const customerIds = Array.from(
    new Set(meetings.map((m) => m.customer_id).filter((v): v is string => Boolean(v))),
  );

  const [recapsResult, integrityResult, ownersResult, customersResult] = await Promise.all([
    meetingIds.length > 0
      ? supabase
          .from("meeting_recaps")
          .select("meeting_id, status, approved_at")
          .in("meeting_id", meetingIds)
      : { data: [] },
    meetingIds.length > 0
      ? supabase
          .from("meeting_integrity_reports")
          .select("meeting_id, overall_verdict")
          .in("meeting_id", meetingIds)
      : { data: [] },
    ownerIds.length > 0
      ? supabase
          .from("organization_memberships")
          .select("id, display_name")
          .in("id", ownerIds)
      : { data: [] },
    customerIds.length > 0
      ? supabase
          .from("customers")
          .select("id, name")
          .in("id", customerIds)
      : { data: [] },
  ]);

  const recapByMeeting = new Map((recapsResult.data ?? []).map((r) => [r.meeting_id, r]));
  const integrityByMeeting = new Map((integrityResult.data ?? []).map((i) => [i.meeting_id, i]));
  const ownerById = new Map((ownersResult.data ?? []).map((o) => [o.id, o.display_name]));
  const customerById = new Map((customersResult.data ?? []).map((c) => [c.id, c.name]));

  return (
    <RoleShell role="manager" userName={membership.displayName} roleLabel="Manager">
      <div className="flex flex-1 flex-col gap-8 p-8 bg-[#0B1D33]">
        <h1 className="text-xl font-semibold tracking-tight text-white">Team Meetings & Review Gate</h1>

      {/* Upcoming Team Meetings */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold tracking-tight text-white">
          Upcoming Team Meetings
        </h2>
        <UpcomingMeetings supabase={supabase} showOwner />
      </section>

      {/* Team Recap Review Queue */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-white">
            Conversation Intelligence & Recap Review Queue
          </h2>
          <span className="text-xs text-[#F5F5F5]/60">
            {meetings.length} recent meeting{meetings.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-[#1E1E1E]/10 bg-white shadow-sm">
          {meetings.length === 0 ? (
            <p className="p-6 text-center text-sm text-[#1E1E1E]/60">No team meetings found.</p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[#1E1E1E]/10 bg-[#F5F5F5] font-medium text-[#1E1E1E]/60">
                <tr>
                  <th className="px-4 py-3">Meeting / Customer</th>
                  <th className="px-4 py-3">Account Manager</th>
                  <th className="px-4 py-3">Scheduled</th>
                  <th className="px-4 py-3">Integrity Verdict</th>
                  <th className="px-4 py-3">Recap Status</th>
                  <th className="px-4 py-3 text-right">Review Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E1E1E]/10">
                {meetings.map((m) => {
                  const recap = recapByMeeting.get(m.id);
                  const integrity = integrityByMeeting.get(m.id);
                  const ownerName = m.owner_membership_id ? ownerById.get(m.owner_membership_id) ?? "Unknown AM" : "Unassigned";
                  const customerName = m.customer_id ? customerById.get(m.customer_id) ?? "Unlinked Customer" : null;

                  return (
                    <tr key={m.id} className="hover:bg-[#F5F5F5]/50">
                      <td className="px-4 py-3 font-medium text-[#1E1E1E]">
                        <div className="truncate max-w-xs">{m.title}</div>
                        {customerName && (
                          <div className="text-[11px] text-[#1E1E1E]/60">{customerName}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#1E1E1E]/70">{ownerName}</td>
                      <td className="px-4 py-3 text-[#1E1E1E]/60">
                        {new Date(m.scheduled_start).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-3">
                        {integrity ? (
                          <StatusBadge tone={INTEGRITY_TONE[integrity.overall_verdict] ?? "neutral"}>
                            {INTEGRITY_LABELS[integrity.overall_verdict] ?? integrity.overall_verdict}
                          </StatusBadge>
                        ) : (
                          <span className="text-[#1E1E1E]/40 italic">Not evaluated</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {recap ? (
                          <StatusBadge tone={RECAP_TONE[recap.status] ?? "neutral"}>
                            {recap.status === "approved" ? "Approved" : recap.status === "ready_for_review" ? "Ready for Review" : "Draft"}
                          </StatusBadge>
                        ) : (
                          <span className="text-[#1E1E1E]/40 italic">No recap</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/meetings/${m.id}/recap`}
                          className="font-medium text-[#2C76FF] hover:text-[#2C76FF]/80"
                        >
                          Review Recap →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

        <div className="flex gap-4 pt-2">
          <Link href="/manager/team" className="w-fit text-sm text-[#2C76FF] hover:underline">
            Team portfolio
          </Link>
          <Link href="/actions" className="w-fit text-sm text-[#2C76FF] hover:underline">
            Actions
          </Link>
        </div>
      </div>
    </RoleShell>
  );
}
