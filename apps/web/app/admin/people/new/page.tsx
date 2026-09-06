import { getCurrentMembership } from "@applywizz/auth";
import { getOrgReferenceData } from "@/lib/people-queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { AddPersonForm } from "./add-person-form";

export default async function AddPersonPage() {
  await requireRole(["admin"]);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);
  const reference = await getOrgReferenceData(
    supabase,
    membership.organizationId,
  );

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold tracking-tight">Add Person</h1>
      <AddPersonForm reference={reference} />
    </main>
  );
}
