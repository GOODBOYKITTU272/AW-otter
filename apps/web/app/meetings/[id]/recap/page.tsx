import Link from "next/link";
import { notFound } from "next/navigation";

import { MeetingRecap } from "@/components/recap/meeting-recap";
import { getMeetingRecapData } from "@applywizz/domain/meeting-recap";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const STATE_MESSAGES: Record<string, string> = {
  transcript_processing:
    "Transcript processing. Check back once the meeting has finished being transcribed.",
  intelligence_not_ready:
    "Intelligence not ready. Check back once this call has been analyzed.",
};

// M11: real production recap — converts the M11 fixture-driven prep into a
// backend-wired read of M8 transcripts / M9 ai_runs+call_records+
// customer_truth_facts / M10 effective truth, via getMeetingRecapData. RLS
// on `meetings` (and everything joined off it) is what actually decides
// visibility; this page never re-derives that.
export default async function MeetingRecapPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();
  const { id } = await params;

  const state = await getMeetingRecapData(supabase, id);
  if (!state) notFound();

  if (state.status === "ready") {
    return <MeetingRecap recap={state.recap} />;
  }

  const errorCode =
    state.status === "transcript_failed" ||
    state.status === "intelligence_failed"
      ? state.errorCode
      : null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <Link
        href="/home"
        className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
      >
        Back to AM home
      </Link>
      <div className="rounded-lg border border-zinc-200 p-6 text-sm dark:border-zinc-800">
        <p className="text-zinc-700 dark:text-zinc-300">
          {state.status === "transcript_failed"
            ? "Transcript failed."
            : state.status === "intelligence_failed"
              ? "Intelligence failed."
              : STATE_MESSAGES[state.status]}
        </p>
        {errorCode ? (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            {errorCode}
          </p>
        ) : null}
      </div>
    </div>
  );
}
