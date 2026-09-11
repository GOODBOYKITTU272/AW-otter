import Link from "next/link";
import { MetricCard } from "@/components/admin/metric-card";
import { StatusBadge } from "@/components/admin/status-badge";
import { CustomerLinkControl } from "@/components/customer-link-control";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * AM-friendly Meetings overview with plain English labels and Apply Wizz branding.
 * Focus: Meeting title, When, Who (AM), Customer, Bot, Transcript, Next action.
 * Technical details hidden behind optional disclosure for admins only.
 */

type LifecycleStatus = string;
type BotStatus = string;

// Human-friendly status mapping (Upcoming / Live / Done / Needs review / Failed)
function meetingStatusBadge(
  lifecycle: LifecycleStatus,
  botStatus: BotStatus | undefined,
) {
  if (lifecycle === "cancelled")
    return <StatusBadge tone="neutral">Cancelled</StatusBadge>;
  if (lifecycle === "completed")
    return <StatusBadge tone="success">Done</StatusBadge>;
  if (botStatus === "joined")
    return <StatusBadge tone="info">Live now</StatusBadge>;
  if (botStatus === "joining")
    return <StatusBadge tone="warning">Joining...</StatusBadge>;
  return <StatusBadge tone="info">Upcoming</StatusBadge>;
}

function botStatusLabel(status: string | undefined): string {
  if (!status) return "Not scheduled";
  const labels: Record<string, string> = {
    pending: "Preparing",
    scheduled: "Ready to join",
    joining: "Joining now",
    joined: "Recording",
    completed: "Recorded",
    cancelled: "Cancelled",
    failed: "Failed to join",
  };
  return labels[status] ?? status;
}

function botStatusBadge(status: string | undefined) {
  if (!status)
    return <span className="text-zinc-400 text-sm">Not scheduled</span>;
  
  const tones: Record<string, "success" | "warning" | "critical" | "info" | "neutral"> = {
    pending: "neutral",
    scheduled: "info",
    joining: "warning",
    joined: "success",
    completed: "success",
    cancelled: "neutral",
    failed: "critical",
  };
  
  return (
    <StatusBadge tone={tones[status] ?? "neutral"}>
      {botStatusLabel(status)}
    </StatusBadge>
  );
}

function transcriptStatusBadge(transcript: {
  processing_status: string;
  error_code: string | null;
} | null) {
  if (!transcript)
    return <span className="text-zinc-400 text-sm">Pending</span>;
  
  if (transcript.processing_status === "completed")
    return <StatusBadge tone="success">Ready</StatusBadge>;
  if (transcript.processing_status === "failed")
    return <StatusBadge tone="critical">Failed</StatusBadge>;
  if (transcript.processing_status === "processing")
    return <StatusBadge tone="info">Processing...</StatusBadge>;
  
  return <StatusBadge tone="neutral">Pending</StatusBadge>;
}

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other",
};

function customerCell(
  meeting: {
    id: string;
    customer_id: string | null;
    customer_link_status: string | null;
    needs_link_reason: string | null;
    call_type: string | null;
    owner_membership_id: string | null;
  },
  customerNameById: Map<string, string>,
  customersByOwner: Map<string, { id: string; name: string }[]>,
) {
  if (
    meeting.customer_link_status === "linked_auto" ||
    meeting.customer_link_status === "linked_manual"
  ) {
    const name = meeting.customer_id
      ? customerNameById.get(meeting.customer_id)
      : undefined;
    return (
      <div className="flex flex-col gap-0.5">
        <Link
          href={meeting.customer_id ? `/customers/${meeting.customer_id}` : "#"}
          className="font-medium text-[#2C76FF] hover:underline"
        >
          {name ?? "Unknown"}
        </Link>
        {meeting.call_type && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {CALL_TYPE_LABEL[meeting.call_type] ?? meeting.call_type}
          </span>
        )}
      </div>
    );
  }
  if (meeting.customer_link_status === "needs_link") {
    return (
      <CustomerLinkControl
        meetingId={meeting.id}
        needsLinkReason={meeting.needs_link_reason}
        candidates={
          meeting.owner_membership_id
            ? (customersByOwner.get(meeting.owner_membership_id) ?? [])
            : []
        }
      />
    );
  }
  return <span className="text-zinc-400 text-sm">—</span>;
}

function nextActionCell(
  meeting: {
    lifecycle_status: string;
    customer_link_status: string | null;
  },
  transcript: { processing_status: string } | null,
  intelligenceRunStatus: string | null,
) {
  // Needs review: Customer needs linking
  if (meeting.customer_link_status === "needs_link") {
    return (
      <span className="text-sm text-amber-600 dark:text-amber-400">
        Link customer
      </span>
    );
  }
  
  // Done: Meeting completed with transcript
  if (meeting.lifecycle_status === "completed" && transcript?.processing_status === "completed") {
    if (intelligenceRunStatus === "completed") {
      return (
        <span className="text-sm text-zinc-500 dark:text-zinc-400">
          Review recap
        </span>
      );
    }
    return (
      <span className="text-sm text-zinc-500 dark:text-zinc-400">
        Processing insights
      </span>
    );
  }
  
  // Failed: Transcript or bot failed
  if (transcript?.processing_status === "failed") {
    return (
      <span className="text-sm text-red-600 dark:text-red-400">
        Transcript failed
      </span>
    );
  }
  
  // Upcoming or in progress
  return <span className="text-sm text-zinc-400">—</span>;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const meetingDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  
  if (meetingDate.getTime() === today.getTime()) {
    return `Today ${date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function AdminMeetingsPage() {
  const supabase = await getSupabaseServerClient();

  const [
    meetingsResult,
    botJobsResult,
    customersResult,
    membershipsResult,
    transcriptsResult,
    intelligenceRunsResult,
  ] = await Promise.all([
    supabase
      .from("meetings")
      .select(
        "id, title, scheduled_start, lifecycle_status, customer_id, customer_link_status, needs_link_reason, call_type, owner_membership_id",
      )
      .order("scheduled_start", { ascending: false })
      .limit(50),
    supabase
      .from("meeting_bot_jobs")
      .select("id, meeting_id, status, generation")
      .order("generation", { ascending: false }),
    supabase.from("customers").select("id, name, owner_membership_id"),
    supabase.from("organization_memberships").select("id, display_name"),
    supabase
      .from("meeting_transcripts")
      .select("id, meeting_id, processing_status, error_code"),
    supabase
      .from("ai_runs")
      .select("id, meeting_id, status")
      .eq("run_type", "meeting_intelligence"),
  ]);

  if (meetingsResult.error) throw meetingsResult.error;
  if (botJobsResult.error) throw botJobsResult.error;
  if (customersResult.error) throw customersResult.error;
  if (membershipsResult.error) throw membershipsResult.error;
  if (transcriptsResult.error) throw transcriptsResult.error;
  if (intelligenceRunsResult.error) throw intelligenceRunsResult.error;

  const meetings = meetingsResult.data;
  const botJobs = botJobsResult.data;
  const customers = customersResult.data;
  const memberships = membershipsResult.data;
  const transcripts = transcriptsResult.data;
  const intelligenceRuns = intelligenceRunsResult.data;

  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const membershipNameById = new Map(
    memberships.map((m) => [m.id, m.display_name]),
  );
  const customersByOwner = new Map<string, { id: string; name: string }[]>();
  for (const c of customers) {
    const existing = customersByOwner.get(c.owner_membership_id) ?? [];
    existing.push({ id: c.id, name: c.name });
    customersByOwner.set(c.owner_membership_id, existing);
  }

  const latestBotJobByMeetingId = new Map<string, (typeof botJobs)[number]>();
  for (const botJob of botJobs) {
    if (!latestBotJobByMeetingId.has(botJob.meeting_id))
      latestBotJobByMeetingId.set(botJob.meeting_id, botJob);
  }

  const transcriptByMeetingId = new Map(
    transcripts.map((t) => [t.meeting_id, t]),
  );

  const intelligenceRunByMeetingId = new Map(
    intelligenceRuns.map((r) => [r.meeting_id, r.status]),
  );

  // Metrics for overview cards
  const upcomingCount = meetings.filter(
    (m) => m.lifecycle_status === "upcoming",
  ).length;
  const liveCount = meetings.filter(
    (m) => latestBotJobByMeetingId.get(m.id)?.status === "joined",
  ).length;
  const completedCount = meetings.filter(
    (m) => m.lifecycle_status === "completed",
  ).length;
  const needsLinkCount = meetings.filter(
    (m) => m.customer_link_status === "needs_link",
  ).length;

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 bg-[#F5F5F5] dark:bg-[#0B1D33] min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E] dark:text-white">
            Meetings
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
            Track customer meetings, recordings, and transcripts
          </p>
        </div>
      </div>

      {/* Metrics Overview */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <MetricCard label="Upcoming" value={upcomingCount} tone="info" />
        <MetricCard
          label="Live now"
          value={liveCount}
          tone={liveCount > 0 ? "warning" : "neutral"}
        />
        <MetricCard label="Completed" value={completedCount} tone="success" />
        <MetricCard
          label="Needs review"
          value={needsLinkCount}
          tone={needsLinkCount > 0 ? "warning" : "neutral"}
        />
      </section>

      {/* Main Meetings Table */}
      <section className="flex flex-col gap-3 bg-white dark:bg-[#1E1E1E] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <div className="px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="font-semibold text-[#1E1E1E] dark:text-white">
            Recent meetings
          </h2>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
                <th className="px-6 py-3 font-medium">Status</th>
                <th className="px-6 py-3 font-medium">Meeting</th>
                <th className="px-6 py-3 font-medium">When</th>
                <th className="px-6 py-3 font-medium">Account Manager</th>
                <th className="px-6 py-3 font-medium">Customer</th>
                <th className="px-6 py-3 font-medium">Echo Bot</th>
                <th className="px-6 py-3 font-medium">Transcript</th>
                <th className="px-6 py-3 font-medium">Next action</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map((meeting) => {
                const botJob = latestBotJobByMeetingId.get(meeting.id);
                const transcript = transcriptByMeetingId.get(meeting.id);
                const intelligenceStatus = intelligenceRunByMeetingId.get(meeting.id);
                
                return (
                  <tr
                    key={meeting.id}
                    className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-900 dark:hover:bg-zinc-900/30 transition-colors"
                  >
                    <td className="px-6 py-4">
                      {meetingStatusBadge(meeting.lifecycle_status, botJob?.status)}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/admin/meetings/${meeting.id}`}
                        className="font-medium text-[#2C76FF] hover:underline"
                      >
                        {meeting.title}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-zinc-600 dark:text-zinc-400">
                      {formatDateTime(meeting.scheduled_start)}
                    </td>
                    <td className="px-6 py-4 text-zinc-600 dark:text-zinc-400">
                      {meeting.owner_membership_id
                        ? membershipNameById.get(meeting.owner_membership_id) ?? "—"
                        : "—"}
                    </td>
                    <td className="px-6 py-4">
                      {customerCell(meeting, customerNameById, customersByOwner)}
                    </td>
                    <td className="px-6 py-4">
                      {botStatusBadge(botJob?.status)}
                    </td>
                    <td className="px-6 py-4">
                      {transcriptStatusBadge(transcript ?? null)}
                    </td>
                    <td className="px-6 py-4">
                      {nextActionCell(meeting, transcript ?? null, intelligenceStatus ?? null)}
                    </td>
                  </tr>
                );
              })}
              {meetings.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-6 py-12 text-center text-zinc-500"
                  >
                    No meetings yet. Meetings will appear here once your calendar is connected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Technical Details - Optional Disclosure */}
      <details className="group bg-white dark:bg-[#1E1E1E] rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
        <summary className="cursor-pointer px-6 py-4 font-medium text-zinc-700 hover:text-[#2C76FF] dark:text-zinc-300 dark:hover:text-[#29FE29] transition-colors">
          🔧 Technical details (for admins)
        </summary>
        <div className="px-6 pb-6 pt-2 space-y-6">
          <div className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2">
            <p className="font-medium text-zinc-700 dark:text-zinc-300">Debug Information</p>
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <span className="font-mono text-zinc-500">Total meetings loaded:</span>{" "}
                <span className="font-mono">{meetings.length}</span>
              </div>
              <div>
                <span className="font-mono text-zinc-500">Bot jobs tracked:</span>{" "}
                <span className="font-mono">{botJobs.length}</span>
              </div>
              <div>
                <span className="font-mono text-zinc-500">Transcripts processed:</span>{" "}
                <span className="font-mono">{transcripts.length}</span>
              </div>
              <div>
                <span className="font-mono text-zinc-500">Intelligence runs:</span>{" "}
                <span className="font-mono">{intelligenceRuns.length}</span>
              </div>
            </div>
          </div>
          
          <div className="rounded-lg bg-zinc-50 dark:bg-zinc-900/50 p-4 text-xs font-mono space-y-1">
            <p className="text-zinc-500">Raw database queries returning real data from:</p>
            <ul className="list-disc list-inside text-zinc-600 dark:text-zinc-400 space-y-0.5 ml-2">
              <li>meetings (lifecycle, scheduling)</li>
              <li>meeting_bot_jobs (Echo bot status)</li>
              <li>meeting_transcripts (transcription pipeline)</li>
              <li>ai_runs (intelligence processing)</li>
              <li>customers (customer linkage)</li>
              <li>organization_memberships (AM attribution)</li>
            </ul>
          </div>
        </div>
      </details>
    </main>
  );
}
