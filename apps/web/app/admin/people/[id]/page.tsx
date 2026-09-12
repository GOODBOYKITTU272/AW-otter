import { notFound } from "next/navigation";
import { getCurrentMembership } from "@applywizz/auth";
import { getConnectionStatus } from "@applywizz/domain/microsoft-connection";
import {
  getOrgReferenceData,
  getPerson,
  getPersonAuditEvents,
} from "@/lib/people-queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";
import { AdminBackLink } from "@/components/admin/admin-back-link";
import { EditPersonForm } from "./edit-person-form";

const MICROSOFT_STATUS_LABEL: Record<string, string> = {
  not_connected: "Not Connected",
  pending: "Pending",
  active: "Connected",
  error: "Error / Needs Reconnect",
  disconnected: "Not Connected",
};

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

  const [reference, activity, microsoftStatus] = await Promise.all([
    getOrgReferenceData(supabase, membership.organizationId),
    getPersonAuditEvents(supabase, id),
    getConnectionStatus(supabase, id),
  ]);

  return (
    <main className="flex flex-1 flex-col gap-8 p-8">
      <div>
        <AdminBackLink href="/admin/people" label="Back to Team" />
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-[#1E1E1E]">
          {person.displayName}
        </h1>
        <p className="text-sm text-zinc-600">
          {person.workEmail}
        </p>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-600">Account</h2>
        <p className="text-sm text-zinc-900">
          Membership status:{" "}
          <span className="font-medium">{person.status}</span>
          {" · "}
          User account: {person.userLinked ? "linked" : "not linked yet"}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-zinc-600">
          Role &amp; Reporting
        </h2>
        <EditPersonForm person={person} reference={reference} />
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-zinc-600">
          Microsoft Calendar
        </h2>
        <p className="text-sm text-zinc-900">
          {MICROSOFT_STATUS_LABEL[microsoftStatus.status]}
        </p>
        {microsoftStatus.status !== "active" ? (
          <p className="text-sm text-zinc-600">
            This person must connect their own Microsoft account from their
            Integrations page — an Admin cannot do this on their behalf.
          </p>
        ) : (
          <p className="text-sm text-zinc-600">
            Last sync:{" "}
            {microsoftStatus.lastSyncAt
              ? new Date(microsoftStatus.lastSyncAt).toLocaleString()
              : "Never"}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-zinc-600">Recent Activity</h2>
        {activity.length === 0 ? (
          <p className="text-sm text-zinc-600">No recorded activity yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {activity.map((event) => (
              <li
                key={event.id}
                className="border-b border-zinc-200 pb-2 text-zinc-900"
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
