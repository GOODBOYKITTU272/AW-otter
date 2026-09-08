import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { RequestDoNotRecordAction } from "@/components/request-do-not-record-action";
import { CustomerLinkControl } from "@/components/customer-link-control";
import { CallTypeConfirmControl } from "@/components/call-type-confirm-control";

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other / Unknown",
};

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

const BOT_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  scheduled: "info",
  joining: "warning",
  joined: "success",
  completed: "success",
  cancelled: "neutral",
  failed: "critical",
};

// Deliberately human, never a raw provider status or provider-specific
// term ("Vexa", provider bot ids) — blueprint's "Required AM simplicity"
// mockup shows exactly this line, no Invite Bot button, no provider
// settings, ever.
const BOT_STATUS_LABEL: Record<string, string> = {
  pending: "Preparing ApplyWizz Meeting Assistant",
  scheduled: "ApplyWizz Meeting Assistant scheduled",
  joining: "ApplyWizz Meeting Assistant joining",
  joined: "ApplyWizz Meeting Assistant in the meeting",
  completed: "ApplyWizz Meeting Assistant completed",
  cancelled: "ApplyWizz Meeting Assistant not attending",
  failed: "ApplyWizz Meeting Assistant could not join",
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
    .select(
      "id, title, meeting_url, scheduled_start, scheduled_end, eligibility_status, customer_id, customer_link_status, needs_link_reason, call_type, owner_membership_id",
    )
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
    pendingMeetingIds = new Set(
      (pendingRequests ?? []).map((r) => r.meeting_id),
    );
  }

  // meeting_bot_jobs RLS mirrors meetings' own visibility (see M6's
  // meeting_bot_jobs_select_meeting_visible policy) — the same query
  // works unmodified for an AM's own meetings or an admin's org-wide view.
  const { data: botJobs, error: botJobsError } = await supabase
    .from("meeting_bot_jobs")
    .select("meeting_id, status")
    .in(
      "meeting_id",
      meetings.map((m) => m.id),
    )
    .order("generation", { ascending: false });
  if (botJobsError) throw botJobsError;
  const botStatusByMeetingId = new Map<string, string>();
  for (const job of botJobs ?? []) {
    if (!botStatusByMeetingId.has(job.meeting_id))
      botStatusByMeetingId.set(job.meeting_id, job.status);
  }

  // customers RLS mirrors the same own-vs-admin-org-wide visibility as
  // meetings — no role branching needed here either.
  const { data: customers, error: customersError } = await supabase
    .from("customers")
    .select("id, name, owner_membership_id");
  if (customersError) throw customersError;
  const customerNameById = new Map(
    (customers ?? []).map((c) => [c.id, c.name]),
  );
  const customersByOwner = new Map<string, { id: string; name: string }[]>();
  for (const c of customers ?? []) {
    const existing = customersByOwner.get(c.owner_membership_id) ?? [];
    existing.push({ id: c.id, name: c.name });
    customersByOwner.set(c.owner_membership_id, existing);
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
            <StatusBadge
              tone={ELIGIBILITY_TONE[meeting.eligibility_status] ?? "neutral"}
            >
              {ELIGIBILITY_LABEL[meeting.eligibility_status] ??
                meeting.eligibility_status}
            </StatusBadge>
            {botStatusByMeetingId.has(meeting.id) ? (
              <StatusBadge
                tone={
                  BOT_STATUS_TONE[botStatusByMeetingId.get(meeting.id)!] ??
                  "neutral"
                }
              >
                {BOT_STATUS_LABEL[botStatusByMeetingId.get(meeting.id)!] ??
                  botStatusByMeetingId.get(meeting.id)}
              </StatusBadge>
            ) : null}
            {meeting.customer_link_status === "linked_auto" ||
            meeting.customer_link_status === "linked_manual" ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {meeting.customer_id
                  ? customerNameById.get(meeting.customer_id)
                  : null}
                {meeting.call_type
                  ? ` — ${CALL_TYPE_LABEL[meeting.call_type] ?? meeting.call_type}`
                  : ""}
              </span>
            ) : null}
            {meeting.customer_link_status === "needs_link" ? (
              <CustomerLinkControl
                meetingId={meeting.id}
                needsLinkReason={meeting.needs_link_reason}
                candidates={
                  meeting.owner_membership_id
                    ? (customersByOwner.get(meeting.owner_membership_id) ?? [])
                    : []
                }
              />
            ) : null}
            {meeting.customer_id && !meeting.call_type ? (
              <CallTypeConfirmControl meetingId={meeting.id} />
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {meeting.meeting_url ? (
              <a
                href={meeting.meeting_url}
                className="underline"
                target="_blank"
                rel="noreferrer"
              >
                Join
              </a>
            ) : null}
            {showRequestAction ? (
              <RequestDoNotRecordAction
                meetingId={meeting.id}
                alreadyPending={pendingMeetingIds.has(meeting.id)}
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
