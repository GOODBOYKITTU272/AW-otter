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
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-[#1E1E1E]">
            Echo Control Center
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Real-time operations, speech pipelines, and intelligence health
          </p>
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
          <p className="text-3xl font-bold text-[#1E1E1E]">
            {meetingCount}
          </p>
          <p className="text-xs font-semibold text-zinc-600 mt-2 uppercase tracking-wider">
            Meetings Today
          </p>
        </div>

        <div className="rounded-xl border border-[#2C76FF]/20 bg-white p-6 shadow-sm">
          <p className="text-3xl font-bold text-[#2C76FF]">
            {botsJoined}
          </p>
          <p className="text-xs font-semibold text-zinc-600 mt-2 uppercase tracking-wider">
            Bots Joined
          </p>
        </div>

        <div className="rounded-xl border border-[#29FE29]/30 bg-white p-6 shadow-sm">
          <p className="text-3xl font-bold text-[#29FE29]">
            {transcriptsReady}
          </p>
          <p className="text-xs font-semibold text-zinc-600 mt-2 uppercase tracking-wider">
            Transcripts Ready
          </p>
        </div>

        <div className="rounded-xl border border-[#FFDE59]/30 bg-white p-6 shadow-sm">
          <p className="text-3xl font-bold text-[#FFDE59]">
            {needsReviewCount ?? 0}
          </p>
          <p className="text-xs font-semibold text-zinc-600 mt-2 uppercase tracking-wider">
            Needs Review
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white shadow-sm">
        <div className="border-b border-zinc-200 px-6 py-4">
          <h2 className="text-base font-semibold text-[#1E1E1E]">
            System Health &amp; Pipeline Status
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Microsoft Graph
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Calendar & meetings sync</p>
            </div>
            <StatusBadge tone={isM365Connected ? "success" : m365Conn?.status ? "warning" : "neutral"}>
              {isM365Connected ? "Connected" : m365Conn?.status ? m365Conn.status : "Not connected"}
            </StatusBadge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Azure MAI
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Primary transcriber</p>
            </div>
            <StatusBadge tone={isAzureConfigured ? "neutral" : "warning"}>
              {isAzureConfigured ? "Configured" : "Not configured"}
            </StatusBadge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Sarvam AI
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Fallback STT #2</p>
            </div>
            <StatusBadge tone="neutral">
              Configured
            </StatusBadge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Whisper
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Fallback STT #3</p>
            </div>
            <StatusBadge tone={isOpenRouterConfigured ? "neutral" : "warning"}>
              {isOpenRouterConfigured ? "Configured" : "Not configured"}
            </StatusBadge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Supabase
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Database & storage</p>
            </div>
            <StatusBadge tone={isDatabaseReachable ? "success" : "critical"}>
              {isDatabaseReachable ? "Operational" : "Unreachable"}
            </StatusBadge>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <span className="text-sm font-medium text-[#1E1E1E]">
                Vexa Bot
              </span>
              <p className="text-xs text-zinc-500 mt-0.5">Meeting recorder</p>
            </div>
            <StatusBadge tone={botsJoined > 0 || waitingForHost > 0 ? "success" : "neutral"}>
              {botsJoined > 0 || waitingForHost > 0 ? "Active" : "Idle"}
            </StatusBadge>
          </div>
        </div>
      </section>

      {(waitingForHost > 0 || botErrors > 0 || (needsReviewCount ?? 0) > 0) && (
        <section className="rounded-xl border border-[#FFDE59] bg-[#FFFBEA] p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-[#92400E]">
            Attention Required ({waitingForHost + botErrors + (needsReviewCount ?? 0)})
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-sm text-[#78350F]">
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
        <h2 className="text-base font-semibold text-[#1E1E1E]">
          Upcoming meetings (organization-wide)
        </h2>
        <UpcomingMeetings supabase={supabase} />
      </section>
    </main>
  );
}
