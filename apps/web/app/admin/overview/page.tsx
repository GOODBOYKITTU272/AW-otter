import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { StatusBadge } from "@/components/admin/status-badge";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAzureMaiEnv } from "@/env/server";

export default async function AdminOverviewPage() {
  const supabase = await getSupabaseServerClient();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const { data: meetingsToday } = await supabase
    .from("meetings")
    .select("id, title, lifecycle_status, scheduled_start")
    .gte("scheduled_start", todayStart.toISOString())
    .lte("scheduled_start", todayEnd.toISOString());

  const meetingCount = (meetingsToday ?? []).length;

  const { data: botJobs } = await supabase
    .from("meeting_bot_jobs")
    .select("id, status, last_error, meeting_id");

  const botsJoined = (botJobs ?? []).filter(
    (b) => b.status === "completed" || b.status === "joined",
  ).length;
  const waitingForHost = (botJobs ?? []).filter(
    (b) => b.status === "scheduled" || b.status === "joining",
  ).length;
  const botErrors = (botJobs ?? []).filter((b) => b.status === "failed").length;

  const { data: transcripts } = await supabase
    .from("meeting_transcripts")
    .select("id, processing_status");

  const transcriptsReady = (transcripts ?? []).filter(
    (t) => t.processing_status === "completed",
  ).length;

  const { count: needsReviewCount } = await supabase
    .from("transcript_segments")
    .select("id", { count: "exact", head: true })
    .eq("needs_review", true);

  const { data: m365Conn } = await supabase
    .from("microsoft_tenant_connections")
    .select("id, status")
    .maybeSingle();

  const isM365Connected = m365Conn?.status === "active";

  const azureEnv = getAzureMaiEnv();
  const isAzureConfigured = azureEnv.isConfigured;
  const isOpenRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const isDatabaseReachable = Boolean(meetingsToday !== null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-7xl bg-[#0B1D33]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Echo Control Center
          </h1>
          <p className="mt-1 text-sm text-[#F5F5F5]/70">
            Real-time operations, speech pipelines, and intelligence health
          </p>
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] p-6 shadow-lg">
          <p className="text-3xl font-bold text-white">
            {meetingCount}
          </p>
          <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
            Meetings Today
          </p>
        </div>

        <div className="rounded-xl border border-[#2C76FF]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#2C76FF]/10">
          <p className="text-3xl font-bold text-[#2C76FF]">
            {botsJoined}
          </p>
          <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
            Echo Joined
          </p>
        </div>

        <div className="rounded-xl border border-[#29FE29]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#29FE29]/10">
          <p className="text-3xl font-bold text-[#29FE29]">
            {transcriptsReady}
          </p>
          <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
            Transcripts Ready
          </p>
        </div>

        <div className="rounded-xl border border-[#FFDE59]/20 bg-[#1E1E1E] p-6 shadow-lg shadow-[#FFDE59]/10">
          <p className="text-3xl font-bold text-[#FFDE59]">
            {needsReviewCount ?? 0}
          </p>
          <p className="text-xs font-semibold text-[#F5F5F5]/70 mt-2 uppercase tracking-wider">
            Needs Review
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-[#F5F5F5]/10 bg-[#1E1E1E] shadow-lg">
        <div className="border-b border-[#F5F5F5]/10 px-6 py-4">
          <h2 className="text-base font-semibold text-white">
            System Health &amp; Pipeline Status
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#F5F5F5]/10">
          <div className="p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#F5F5F5]/90">
                Microsoft 365 Tenant Sync
              </span>
              <StatusBadge tone={isM365Connected ? "success" : m365Conn?.status ? "warning" : "neutral"}>
                {isM365Connected ? "Connected" : m365Conn?.status ? `Status: ${m365Conn.status}` : "Not connected"}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#F5F5F5]/90">
                Azure Speech (Primary)
              </span>
              <StatusBadge tone={isAzureConfigured ? "neutral" : "warning"}>
                {isAzureConfigured ? "Configured" : "Not configured"}
              </StatusBadge>
            </div>
          </div>

          <div className="p-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#F5F5F5]/90">
                OpenRouter Whisper Fallback
              </span>
              <StatusBadge tone={isOpenRouterConfigured ? "neutral" : "warning"}>
                {isOpenRouterConfigured ? "Configured" : "Not configured"}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#F5F5F5]/90">
                PostgreSQL &amp; Storage
              </span>
              <StatusBadge tone={isDatabaseReachable ? "success" : "critical"}>
                {isDatabaseReachable ? "Operational" : "Degraded"}
              </StatusBadge>
            </div>
          </div>
        </div>
      </section>

      {(waitingForHost > 0 || botErrors > 0 || (needsReviewCount ?? 0) > 0) && (
        <section className="rounded-xl border border-[#FFDE59]/20 bg-[#FFDE59]/10 p-6 shadow-lg">
          <h2 className="text-sm font-semibold text-[#FFDE59]">
            Attention Required ({waitingForHost + botErrors + (needsReviewCount ?? 0)})
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-[#F5F5F5]/90">
            {waitingForHost > 0 && (
              <li>• {waitingForHost} bot session(s) waiting for host to admit</li>
            )}
            {botErrors > 0 && (
              <li>• {botErrors} bot recording attempt(s) encountered errors</li>
            )}
            {(needsReviewCount ?? 0) > 0 && (
              <li>• {needsReviewCount} transcript segment(s) flagged for review</li>
            )}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-white">
          Upcoming meetings (organization-wide)
        </h2>
        <UpcomingMeetings supabase={supabase} />
      </section>
    </main>
  );
}
