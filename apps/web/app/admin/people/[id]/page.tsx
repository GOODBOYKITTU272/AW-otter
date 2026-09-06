import { notFound } from "next/navigation";
import { getCurrentMembership } from "@applywizz/auth";
import {
  getOrgReferenceData,
  getPerson,
  getPersonAuditEvents,
} from "@/lib/people-queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { EditPersonForm } from "./edit-person-form";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole(["admin"]);
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);

  const person = await getPerson(supabase, id);
  if (!person) notFound();

  const [reference, activity] = await Promise.all([
    getOrgReferenceData(supabase, membership.organizationId),
    getPersonAuditEvents(supabase, id),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {person.displayName}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {person.workEmail}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-500">Account</h2>
        <p className="text-sm">
          Membership status:{" "}
          <span className="font-medium">{person.status}</span>
          {" · "}
          User account: {person.userLinked ? "linked" : "not linked yet"}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-500">
          Role &amp; Reporting
        </h2>
        <EditPersonForm person={person} reference={reference} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-500">Recent Activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-zinc-500">No recorded activity yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {activity.map((event) => (
              <li
                key={event.id}
                className="border-b border-zinc-100 pb-2 dark:border-zinc-900"
              >
                <span className="font-medium">{event.action}</span>
                {" — "}
                {event.actorName} ·{" "}
                {new Date(event.occurredAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
