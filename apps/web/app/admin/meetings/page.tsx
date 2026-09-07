import { MetricCard } from "@/components/admin/metric-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M4 operational view of the future Admin Meetings screen (blueprint
// screen 02) — later milestones add filters, the meeting detail drawer,
// transcript/AI panels, etc. Every number and row here is read straight
// from the DB via the same RLS an org admin already has
// (meetings_select_admin_org / calendar_event_jobs_select_admin_org /
// calendar_connections_select_admin_org) — nothing is fabricated for
// display, and a section is simply empty until the pipeline actually
// produces rows for it.

type LifecycleStatus = string;

function lifecycleBadge(status: LifecycleStatus) {
  if (status === "cancelled")
    return <StatusBadge tone="critical">Cancelled</StatusBadge>;
  if (status === "completed")
    return <StatusBadge tone="success">Completed</StatusBadge>;
  return <StatusBadge tone="info">Upcoming</StatusBadge>;
}

type JobRow = {
  id: string;
  external_event_id: string;
  provider_user_key: string;
  change_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  run_at: string;
  created_at: string;
};

/** Worst-status-wins across every mailbox that's observed this meeting — one canonical meeting can now have several. */
function syncStateBadge(jobs: JobRow[]) {
  if (jobs.length === 0)
    return <StatusBadge tone="neutral">No queue activity</StatusBadge>;
  if (jobs.some((job) => job.status === "dead_letter"))
    return <StatusBadge tone="critical">Sync failed</StatusBadge>;
  if (
    jobs.some((job) => job.status === "pending" || job.status === "processing")
  )
    return <StatusBadge tone="warning">Syncing</StatusBadge>;
  return <StatusBadge tone="success">Synced</StatusBadge>;
}

const BOT_STATUS_TONE: Record<
  string,
  "success" | "warning" | "critical" | "info" | "neutral"
> = {
  pending: "neutral",
  scheduled: "info",
  joining: "warning",
  joined: "success",
  completed: "success",
  cancelled: "neutral",
  failed: "critical",
};

const BOT_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  joining: "Joining",
  joined: "In meeting",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

function botStatusBadge(status: string | undefined) {
  if (!status) return <span className="text-zinc-400">—</span>;
  return (
    <StatusBadge tone={BOT_STATUS_TONE[status] ?? "neutral"}>
      {BOT_STATUS_LABEL[status] ?? status}
    </StatusBadge>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function AdminMeetingsPage() {
  const supabase = await getSupabaseServerClient();

  const [
    jobsResult,
    meetingsResult,
    connectionsResult,
    mappingsResult,
    botJobsResult,
  ] = await Promise.all([
    supabase
      .from("calendar_event_jobs")
      .select(
        "id, external_event_id, provider_user_key, change_type, status, attempts, last_error, run_at, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("meetings")
      .select(
        "id, ical_uid, title, organizer_name, organizer_email, meeting_type, meeting_url, scheduled_start, scheduled_end, lifecycle_status, reason_code, updated_at",
      )
      .order("scheduled_start", { ascending: false })
      .limit(50),
    supabase
      .from("calendar_connections")
      .select("id, status, last_sync_at, last_reconciliation_result")
      .order("created_at", { ascending: false }),
    supabase
      .from("meeting_external_events")
      .select("meeting_id, external_event_id"),
    supabase
      .from("meeting_bot_jobs")
      .select(
        "id, meeting_id, provider, provider_bot_id, status, generation, retry_count, last_error, scheduled_at, joined_at, created_at",
      )
      .order("generation", { ascending: false }),
  ]);

  if (jobsResult.error) throw jobsResult.error;
  if (meetingsResult.error) throw meetingsResult.error;
  if (connectionsResult.error) throw connectionsResult.error;
  if (mappingsResult.error) throw mappingsResult.error;
  if (botJobsResult.error) throw botJobsResult.error;

  const jobs = jobsResult.data;
  const meetings = meetingsResult.data;
  const connections = connectionsResult.data;
  const mappings = mappingsResult.data;
  const botJobs = botJobsResult.data;
  const latestBotJobByMeetingId = new Map<string, (typeof botJobs)[number]>();
  for (const botJob of botJobs) {
    if (!latestBotJobByMeetingId.has(botJob.meeting_id))
      latestBotJobByMeetingId.set(botJob.meeting_id, botJob);
  }

  // A canonical meeting can now be observed via more than one mailbox —
  // gather every job across every mailbox copy mapped to each meeting, so
  // "Sync state" reflects the whole meeting, not just one observer.
  const jobsByExternalEventId = new Map<string, JobRow[]>();
  for (const job of jobs) {
    const existing = jobsByExternalEventId.get(job.external_event_id) ?? [];
    existing.push(job);
    jobsByExternalEventId.set(job.external_event_id, existing);
  }
  const jobsByMeetingId = new Map<string, JobRow[]>();
  for (const mapping of mappings) {
    const meetingJobs = jobsByExternalEventId.get(mapping.external_event_id);
    if (!meetingJobs) continue;
    const existing = jobsByMeetingId.get(mapping.meeting_id) ?? [];
    jobsByMeetingId.set(mapping.meeting_id, existing.concat(meetingJobs));
  }

  const discoveredEventCount = new Set([
    ...jobs.map((job) => job.external_event_id),
    ...mappings.map((m) => m.external_event_id),
  ]).size;
  const teamsMeetingCount = meetings.filter(
    (meeting) => meeting.meeting_type === "teams",
  ).length;
  const upcomingCount = meetings.filter(
    (meeting) => meeting.lifecycle_status === "upcoming",
  ).length;
  const cancelledCount = meetings.filter(
    (meeting) => meeting.lifecycle_status === "cancelled",
  ).length;
  const needsAttentionCount = jobs.filter(
    (job) => job.status === "pending" || job.status === "dead_letter",
  ).length;

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Meetings</h1>

      <section className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="Discovered events" value={discoveredEventCount} />
        <MetricCard
          label="Teams meetings"
          value={teamsMeetingCount}
          tone="info"
        />
        <MetricCard label="Upcoming" value={upcomingCount} tone="info" />
        <MetricCard
          label="Cancelled"
          value={cancelledCount}
          tone={cancelledCount > 0 ? "critical" : "neutral"}
        />
        <MetricCard
          label="Needs attention"
          value={needsAttentionCount}
          tone={needsAttentionCount > 0 ? "warning" : "success"}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">All meetings</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[1200px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Meeting</th>
                <th className="px-4 py-2.5">Organizer</th>
                <th className="px-4 py-2.5">Start / End</th>
                <th className="px-4 py-2.5">Teams</th>
                <th className="px-4 py-2.5">Join URL</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Sync state</th>
                <th className="px-4 py-2.5">Bot</th>
                <th className="px-4 py-2.5">Rescheduled</th>
                <th className="px-4 py-2.5">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((meeting) => (
                <tr
                  key={meeting.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{meeting.title}</div>
                    <div className="font-mono text-xs text-zinc-400">
                      {meeting.ical_uid}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                    {meeting.organizer_name ?? meeting.organizer_email ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                    {formatDateTime(meeting.scheduled_start)} –{" "}
                    {formatDateTime(meeting.scheduled_end)}
                  </td>
                  <td className="px-4 py-2.5">
                    {meeting.meeting_type === "teams" ? (
                      <StatusBadge tone="info">Teams</StatusBadge>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {meeting.meeting_url ? (
                      <StatusBadge tone="success">Present</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">Not present</StatusBadge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {lifecycleBadge(meeting.lifecycle_status)}
                  </td>
                  <td className="px-4 py-2.5">
                    {syncStateBadge(jobsByMeetingId.get(meeting.id) ?? [])}
                  </td>
                  <td className="px-4 py-2.5">
                    {botStatusBadge(
                      latestBotJobByMeetingId.get(meeting.id)?.status,
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {meeting.reason_code === "rescheduled" ? (
                      <StatusBadge tone="warning">Rescheduled</StatusBadge>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                    {formatDateTime(meeting.updated_at)}
                  </td>
                </tr>
              ))}
              {meetings.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    No meetings yet — meetings appear here once a connected
                    calendar&apos;s events are discovered and synced.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Calendar sync &amp; reconciliation</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Connection</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Last sync</th>
                <th className="px-4 py-2.5">Events seen</th>
                <th className="px-4 py-2.5">Cancelled</th>
                <th className="px-4 py-2.5">Last reconciliation run</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => {
                const result = connection.last_reconciliation_result as {
                  eventsSeen?: number;
                  cancelled?: number;
                  ranAt?: string;
                } | null;
                return (
                  <tr
                    key={connection.id}
                    className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {connection.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-2.5">
                      {connection.status === "active" ? (
                        <StatusBadge tone="success">Active</StatusBadge>
                      ) : (
                        <StatusBadge tone="neutral">
                          {connection.status}
                        </StatusBadge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {connection.last_sync_at
                        ? formatDateTime(connection.last_sync_at)
                        : "Never"}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {result?.eventsSeen ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {result?.cancelled ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">
                      {result?.ranAt
                        ? formatDateTime(result.ranAt)
                        : "Never run"}
                    </td>
                  </tr>
                );
              })}
              {connections.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    No Microsoft connections in this organization.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
          Discovery / Technical — raw queue log
        </summary>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Source event ID</th>
                <th className="px-4 py-2.5">Mailbox</th>
                <th className="px-4 py-2.5">Change type</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Attempts</th>
                <th className="px-4 py-2.5">Last error</th>
                <th className="px-4 py-2.5">Discovered</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {job.external_event_id}
                  </td>
                  <td className="px-4 py-2.5">{job.provider_user_key}</td>
                  <td className="px-4 py-2.5">{job.change_type}</td>
                  <td className="px-4 py-2.5">{job.status}</td>
                  <td className="px-4 py-2.5">{job.attempts}</td>
                  <td className="px-4 py-2.5">{job.last_error ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {formatDateTime(job.created_at)}
                  </td>
                </tr>
              ))}
              {jobs.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    No calendar events discovered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>

      <details className="group">
        <summary className="cursor-pointer text-sm font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
          Meeting Assistant / Technical — bot job log
        </summary>
        <div className="mt-2 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/50">
                <th className="px-4 py-2.5">Meeting</th>
                <th className="px-4 py-2.5">Provider</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Generation</th>
                <th className="px-4 py-2.5">Retries</th>
                <th className="px-4 py-2.5">Scheduled</th>
                <th className="px-4 py-2.5">Joined</th>
                <th className="px-4 py-2.5">Last error</th>
              </tr>
            </thead>
            <tbody>
              {botJobs.map((job) => (
                <tr
                  key={job.id}
                  className="border-b border-zinc-100 last:border-0 dark:border-zinc-900"
                >
                  <td className="px-4 py-2.5">
                    {meetings.find((m) => m.id === job.meeting_id)?.title ??
                      job.meeting_id}
                  </td>
                  <td className="px-4 py-2.5">{job.provider}</td>
                  <td className="px-4 py-2.5">{botStatusBadge(job.status)}</td>
                  <td className="px-4 py-2.5">{job.generation}</td>
                  <td className="px-4 py-2.5">{job.retry_count}</td>
                  <td className="px-4 py-2.5">
                    {job.scheduled_at ? formatDateTime(job.scheduled_at) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {job.joined_at ? formatDateTime(job.joined_at) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-red-600 dark:text-red-400">
                    {job.last_error ?? "—"}
                  </td>
                </tr>
              ))}
              {botJobs.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-4 py-8 text-center text-zinc-500"
                  >
                    No bot jobs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </main>
  );
}
