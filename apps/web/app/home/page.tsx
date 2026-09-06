import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export default async function AccountManagerHomePage() {
  const membership = await requireRole(["account_manager"]);
  const supabase = await getSupabaseServerClient();

  return (
    <main className="flex flex-1 flex-col gap-2 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Home</h1>
        <SignOutButton />
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Signed in as {membership.displayName}.
      </p>
      <Link href="/integrations" className="w-fit text-sm underline">
        Integrations
      </Link>

      <h2 className="mt-4 font-medium">Upcoming meetings</h2>
      <UpcomingMeetings supabase={supabase} />
    </main>
  );
}
