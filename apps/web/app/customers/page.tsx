import Link from "next/link";
import { StatusBadge } from "@/components/admin/status-badge";
import { requireRole } from "@/lib/require-role";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M10: minimal customer portfolio — real data, scoped by RLS to whatever
// the signed-in user (own/manager-in-tree/admin) can see. No lifecycle
// analytics beyond a plain pending-proposal count.
export default async function CustomersPage() {
  await requireRole(["account_manager", "manager", "senior_manager", "admin"]);
  const supabase = await getSupabaseServerClient();

  const { data: customers, error } = await supabase
    .from("customers")
    .select("id, name, lifecycle_stage")
    .order("name", { ascending: true });
  if (error) throw error;

  const { data: proposedFacts, error: factsError } = await supabase
    .from("customer_truth_facts")
    .select("customer_id")
    .eq("status", "proposed");
  if (factsError) throw factsError;

  const pendingCountByCustomer = new Map<string, number>();
  for (const fact of proposedFacts ?? []) {
    pendingCountByCustomer.set(
      fact.customer_id,
      (pendingCountByCustomer.get(fact.customer_id) ?? 0) + 1,
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold tracking-tight">Customers</h1>

      {(customers ?? []).length === 0 ? (
        <p className="text-sm text-zinc-500">No customers yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Lifecycle stage</th>
                <th className="px-4 py-2 font-medium">Pending truth changes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {(customers ?? []).map((customer) => {
                const pending = pendingCountByCustomer.get(customer.id) ?? 0;
                return (
                  <tr key={customer.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/customers/${customer.id}`}
                        className="font-medium hover:underline"
                      >
                        {customer.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                      {customer.lifecycle_stage ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      {pending > 0 ? (
                        <StatusBadge tone="warning">
                          {pending} pending
                        </StatusBadge>
                      ) : (
                        <span className="text-zinc-400">None</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
