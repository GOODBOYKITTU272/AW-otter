import { UpcomingMeetings } from "@/components/upcoming-meetings";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Auth + identity + nav are handled by app/admin/layout.tsx — this page is
// just its content.
export default async function AdminOverviewPage() {
  const supabase = await getSupabaseServerClient();

  return (
    <main className="flex flex-1 flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Upcoming meetings (organization-wide)</h2>
        <UpcomingMeetings supabase={supabase} />
      </section>
    </main>
  );
}
