import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M14: team-wide upcoming meetings. Reuses UpcomingMeetings verbatim —
// RLS (meetings_select_manager_scope: exceptions.approve + is_manager_of,
// a permission the manager/senior_manager roles already carry by
// default) already scopes it to this manager's reporting tree, the same
// way it scopes to "own meetings" for an AM on /home. No new
// authorization, no service-role client anywhere on this page.
export default async function ManagerMeetingsPage() {
  const membership = await requireRole(["manager", "senior_manager"]);
  const supabase = await getSupabaseServerClient();

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Team meetings</h1>
        <SignOutButton />
      </div>
      <p className="-mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        Signed in as {membership.displayName}.
      </p>
      <UpcomingMeetings supabase={supabase} showOwner />
      <div className="flex gap-4">
        <Link href="/manager/team" className="w-fit text-sm underline">
          Team portfolio
        </Link>
        <Link href="/actions" className="w-fit text-sm underline">
          Actions
        </Link>
      </div>
    </main>
  );
}
