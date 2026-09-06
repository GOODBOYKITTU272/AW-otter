import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

/**
 * RLS already scopes the rows: an account manager sees only their own
 * meetings, an org admin sees every meeting in their organization — no
 * role branching needed here, the query is identical either way.
 */
export async function UpcomingMeetings({
  supabase,
}: {
  supabase: SupabaseClient<Database>;
}) {
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, title, meeting_url, scheduled_start, scheduled_end")
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

  return (
    <ul className="flex flex-col gap-2">
      {meetings.map((meeting) => (
        <li
          key={meeting.id}
          className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
        >
          <div className="flex flex-col">
            <span className="font-medium">{meeting.title}</span>
            <span className="text-zinc-500 dark:text-zinc-400">
              {new Date(meeting.scheduled_start).toLocaleString()}
            </span>
          </div>
          {meeting.meeting_url ? (
            <a
              href={meeting.meeting_url}
              className="shrink-0 underline"
              target="_blank"
              rel="noreferrer"
            >
              Join
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
