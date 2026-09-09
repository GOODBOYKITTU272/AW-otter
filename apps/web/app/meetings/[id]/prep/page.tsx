import { notFound } from "next/navigation";
import { MeetingPrep } from "@/components/prep/meeting-prep";
import { getMeetingPrepData } from "@applywizz/domain/meeting-prep";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M12: real meeting preparation — composes the previous meeting's recap
// (canonical `meetings` lookup, not scheduler_calls), customer-wide open
// items, current/pending Customer Truth, journey context, and a
// deterministic recommended focus. RLS on `meetings` (and everything
// joined off it) decides visibility; this page never re-derives that.
export default async function MeetingPrepPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();
  const { id } = await params;

  const prep = await getMeetingPrepData(supabase, id);
  if (!prep) notFound();

  return <MeetingPrep prep={prep} />;
}
