import { getCurrentMembership } from "@applywizz/auth";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { ExceptionQueue } from "@/components/exceptions/exception-queue";

export default async function AdminExceptionsPage() {
  await requireRole(["admin"]);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);

  const { data: requests, error } = await supabase
    .from("recording_exemption_requests")
    .select("id, meeting_id, requested_by, reviewed_by, reason, status, review_notes, requested_at, reviewed_at")
    .eq("organization_id", membership.organizationId)
    .order("requested_at", { ascending: false });
  if (error) throw error;

  const meetingIds = [...new Set(requests.map((r) => r.meeting_id))];
  const membershipIds = [...new Set(requests.flatMap((r) => [r.requested_by, r.reviewed_by].filter((v): v is string => v !== null)))];

  const [meetingsResult, membershipsResult] = await Promise.all([
    meetingIds.length > 0
      ? supabase.from("meetings").select("id, title, scheduled_start").in("id", meetingIds)
      : Promise.resolve({ data: [], error: null }),
    membershipIds.length > 0
      ? supabase.from("organization_memberships").select("id, display_name").in("id", membershipIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (meetingsResult.error) throw meetingsResult.error;
  if (membershipsResult.error) throw membershipsResult.error;

  const meetingsById = new Map((meetingsResult.data ?? []).map((m) => [m.id, m]));
  const membersById = new Map((membershipsResult.data ?? []).map((m) => [m.id, m]));

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E]">Review Queue</h1>
        <p className="mt-1 text-sm text-zinc-600">
          Do-not-record exception requests across the organization. Unresolved requests follow the organization
          default at cutoff.
        </p>
      </div>

      <ExceptionQueue
        requests={requests.map((r) => ({
          id: r.id,
          reason: r.reason,
          status: r.status,
          reviewNotes: r.review_notes,
          requestedAt: r.requested_at,
          reviewedAt: r.reviewed_at,
          meetingTitle: meetingsById.get(r.meeting_id)?.title ?? "Unknown meeting",
          meetingScheduledStart: meetingsById.get(r.meeting_id)?.scheduled_start ?? null,
          requestedByName: membersById.get(r.requested_by)?.display_name ?? "Unknown",
          reviewedByName: r.reviewed_by ? (membersById.get(r.reviewed_by)?.display_name ?? "Unknown") : null,
        }))}
      />
    </main>
  );
}
