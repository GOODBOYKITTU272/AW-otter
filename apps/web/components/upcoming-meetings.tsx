import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { RequestDoNotRecordAction } from "@/components/request-do-not-record-action";

const ELIGIBILITY_TONE: Record<string, BadgeTone> = {
  record: "success",
  exclude: "neutral",
  pending_exception: "warning",
  unsupported: "neutral",
  pending: "info",
};

const ELIGIBILITY_LABEL: Record<string, string> = {
  record: "Will record",
  exclude: "Will not record",
  pending_exception: "Exception pending review",
  unsupported: "Unsupported meeting type",
  pending: "Not yet evaluated",
};

/**
 * RLS already scopes the rows: an account manager sees only their own
 * meetings, an org admin sees every meeting in their organization — no
 * role branching needed here, the query is identical either way.
 *
 * `showRequestAction` additionally renders the AM-facing "Request not to
 * record" workflow (mandatory reason, reviewed by a manager/admin) — kept
 * off by default since it only makes sense for the meeting's own owner,
 * not an admin browsing every meeting in the org.
 */
export async function UpcomingMeetings({
  supabase,
  showRequestAction = false,
}: {
  supabase: SupabaseClient<Database>;
  showRequestAction?: boolean;
}) {
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, title, meeting_url, scheduled_start, scheduled_end, eligibility_status")
    .eq("lifecycle_status", "upcoming")
    .gte("scheduled_start", new Date().toISOString())
    .order("scheduled_start")
    .limit(20);
  if (error) throw error;

  if (!meetings || meetings.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No upcoming meetings.
      </p>
    );
  }

  let pendingMeetingIds = new Set<string>();
  if (showRequestAction) {
    const { data: pendingRequests, error: pendingError } = await supabase
      .from("recording_exemption_requests")
      .select("meeting_id")
      .eq("status", "requested");
    if (pendingError) throw pendingError;
    pendingMeetingIds = new Set((pendingRequests ?? []).map((r) => r.meeting_id));
  }

  return (
    <ul className="flex flex-col gap-2">
      {meetings.map((meeting) => (
        <li
          key={meeting.id}
          className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
        >
          <div className="flex flex-col gap-1">
            <span className="font-medium">{meeting.title}</span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {new Date(meeting.scheduled_start).toLocaleString()}
            </span>
            <StatusBadge tone={ELIGIBILITY_TONE[meeting.eligibility_status] ?? "neutral"}>
              {ELIGIBILITY_LABEL[meeting.eligibility_status] ?? meeting.eligibility_status}
            </StatusBadge>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {meeting.meeting_url ? (
              <a href={meeting.meeting_url} className="underline" target="_blank" rel="noreferrer">
                Join
              </a>
            ) : null}
            {showRequestAction ? (
              <RequestDoNotRecordAction meetingId={meeting.id} alreadyPending={pendingMeetingIds.has(meeting.id)} />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
