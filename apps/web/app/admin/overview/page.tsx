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

  // 1. Fetch meetings today
  const { data: meetingsToday } = await supabase
    .from("meetings")
    .select("id, title, lifecycle_status, scheduled_start")
    .gte("scheduled_start", todayStart.toISOString())
    .lte("scheduled_start", todayEnd.toISOString());

  const meetingCount = (meetingsToday ?? []).length;

  // 2. Fetch Bot jobs status
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

  // 3. Transcripts & review counts
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

  // 4. Microsoft connection health
  const { data: m365Conn } = await supabase
    .from("microsoft_tenant_connections")
    .select("id, status")
    .maybeSingle();

  const isM365Connected = m365Conn?.status === "active";

  // 5. Honest Speech & Storage state (never hardcode 'Healthy')
  const azureEnv = getAzureMaiEnv();
  const isAzureConfigured = azureEnv.isConfigured;
  const isOpenRouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  const isDatabaseReachable = Boolean(meetingsToday !== null);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Echo Control
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Real-time operations, speech pipelines, and intelligence health.
          </p>
        </div>
      </div>

      {/* Control Metrics Grid */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            {meetingCount}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Meetings Today
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {botsJoined}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Echo Joined / Recorded
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
            {transcriptsReady}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Transcripts Ready
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
            {needsReviewCount ?? 0}
          </p>
          <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 mt-1 uppercase tracking-wider">
            Needs Review
          </p>
        </div>
      </section>

      {/* System Health */}
      <section className="rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            System Health &amp; Pipeline Status
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-zinc-100 dark:divide-zinc-900">
          <div className="p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Microsoft 365 Tenant Sync
              </span>
              <StatusBadge tone={isM365Connected ? "success" : m365Conn?.status ? "warning" : "neutral"}>
                {isM365Connected ? "Connected" : m365Conn?.status ? `Status: ${m365Conn.status}` : "Not connected"}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Azure Speech (Primary Transcriber)
              </span>
              <StatusBadge tone={isAzureConfigured ? "neutral" : "warning"}>
                {isAzureConfigured ? "Configured (Not verified)" : "Not configured / Unknown"}
              </StatusBadge>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                OpenRouter Whisper Fallback
              </span>
              <StatusBadge tone={isOpenRouterConfigured ? "neutral" : "warning"}>
                {isOpenRouterConfigured ? "Configured (Not verified)" : "Not configured / Unknown"}
              </StatusBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                PostgreSQL &amp; Storage Vault
              </span>
              <StatusBadge tone={isDatabaseReachable ? "success" : "critical"}>
                {isDatabaseReachable ? "Operational (Database responding)" : "Degraded / Unreachable"}
              </StatusBadge>
            </div>
          </div>
        </div>
      </section>

      {/* Operational Issues Queue if any */}
      {(waitingForHost > 0 || botErrors > 0 || (needsReviewCount ?? 0) > 0) && (
        <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/20">
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Attention Items ({waitingForHost + botErrors + (needsReviewCount ?? 0)})
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-amber-800 dark:text-amber-300">
            {waitingForHost > 0 && (
              <li>• {waitingForHost} bot session(s) waiting for meeting host to admit.</li>
            )}
            {botErrors > 0 && (
              <li>• {botErrors} bot recording attempt(s) encountered exceptions.</li>
            )}
            {(needsReviewCount ?? 0) > 0 && (
              <li>• {needsReviewCount} transcript segment(s) flagged with acoustic/integrity review notices.</li>
            )}
          </ul>
        </section>
      )}

      {/* Upcoming meetings */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          Upcoming meetings (organization-wide)
        </h2>
        <UpcomingMeetings supabase={supabase} />
      </section>
    </main>
  );
}
