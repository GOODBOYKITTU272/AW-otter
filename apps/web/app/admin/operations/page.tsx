import { getCurrentMembership } from "@applywizz/auth";
import { getOperationalHealth } from "@applywizz/domain/operations";
import { listOpenIncidents } from "@applywizz/domain/operational-incidents";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// M16: read-only operational visibility over the four existing job
// queues — no new RLS, no service-role, the caller's own admin session
// already sees this org's rows (calendar_event_jobs_select_admin_org,
// and the meeting-scoped policies which admins see org-wide via
// meetings_select_admin_org). See packages/domain/src/operations.ts for
// what "stuck" means and why it's a real gap none of the four queues'
// existing retry/backoff logic covers.
export default async function AdminOperationsPage() {
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);
  const health = await getOperationalHealth(
    supabase,
    membership.organizationId,
  );
  const openIncidents = await listOpenIncidents(
    supabase,
    membership.organizationId,
  );

  const totalFailed = health.reduce((sum, h) => sum + h.failedCount, 0);
  const totalStuck = health.reduce((sum, h) => sum + h.stuckCount, 0);

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Operations</h1>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-2xl font-semibold text-red-600 dark:text-red-400">
            {totalFailed}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Failed jobs
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-2xl font-semibold text-amber-600 dark:text-amber-400">
            {totalStuck}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Stuck jobs (no progress in 30+ min)
          </p>
        </div>
      </div>

      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Open incidents</h2>
          <StatusBadge tone={openIncidents.length > 0 ? "critical" : "success"}>
            {openIncidents.length > 0 ? `${openIncidents.length} open` : "None"}
          </StatusBadge>
        </div>
        {openIncidents.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No open incidents.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {openIncidents.map((incident) => (
              <li
                key={incident.id}
                className="flex flex-col gap-1 px-4 py-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {incident.queue} · {incident.incidentType}
                  </span>
                  <StatusBadge
                    tone={incident.severity === "critical" ? "critical" : "warning"}
                  >
                    {incident.severity}
                  </StatusBadge>
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    First seen {formatTime(incident.firstSeenAt)} · last seen{" "}
                    {formatTime(incident.lastSeenAt)}
                    {incident.occurrenceCount > 1
                      ? ` · ${incident.occurrenceCount}x`
                      : ""}
                  </span>
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {incident.reason}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {health.map((queue) => {
        const tone: BadgeTone =
          queue.failedCount > 0
            ? "critical"
            : queue.stuckCount > 0
              ? "warning"
              : "success";
        return (
          <section
            key={queue.queue}
            className="rounded-lg border border-zinc-200 dark:border-zinc-800"
          >
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-medium">{queue.queue}</h2>
              <StatusBadge tone={tone}>
                {queue.failedCount > 0 || queue.stuckCount > 0
                  ? `${queue.failedCount} failed · ${queue.stuckCount} stuck`
                  : "Healthy"}
              </StatusBadge>
            </div>
            {queue.failedCount === 0 && queue.stuckCount === 0 ? (
              <p className="px-4 py-6 text-sm text-zinc-500">
                No failures or stuck jobs.
              </p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {[...queue.stuck, ...queue.failed].map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1 px-4 py-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{item.label}</span>
                      <StatusBadge
                        tone={
                          queue.stuck.includes(item) ? "warning" : "critical"
                        }
                      >
                        {queue.stuck.includes(item) ? "Stuck" : item.status}
                      </StatusBadge>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Last updated {formatTime(item.updatedAt)}
                      </span>
                    </div>
                    {item.errorSummary ? (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {item.errorSummary}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </main>
  );
}
