import { notFound } from "next/navigation";
import Link from "next/link";
import { AskSignalPanel } from "@/components/ask-signal/ask-signal-panel";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M13 vertical slice: one coherent, customer-scoped Ask Signal
// experience. Authorization is the same "can the caller see this one
// customer?" check as the parent detail page — RLS decides visibility,
// this page never re-implements it.
export default async function AskSignalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();
  const { id } = await params;

  const { data: customer, error } = await supabase
    .from("customers")
    .select("id, name")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!customer) notFound();

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <Link
          href={`/customers/${id}`}
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← {customer.name}
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-zinc-900 dark:text-zinc-100">
          Ask Signal
        </h1>
      </div>
      <AskSignalPanel customerId={id} />
    </div>
  );
}
