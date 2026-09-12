import { getCurrentMembership } from "@applywizz/auth";
import { getOrgReferenceData } from "@/lib/people-queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { AdminBackLink } from "@/components/admin/admin-back-link";
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
      <div className="flex flex-col gap-2">
        <AdminBackLink href="/admin/people" label="Back to Team" />
        <h1 className="text-xl font-semibold tracking-tight text-[#1E1E1E]">Add Person</h1>
      </div>
      <AddPersonForm reference={reference} />
    </main>
  );
}
