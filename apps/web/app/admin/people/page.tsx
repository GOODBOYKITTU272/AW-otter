import Link from "next/link";
import { getCurrentMembership } from "@applywizz/auth";
import { getOrgReferenceData, listPeople } from "@/lib/people-queries";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/require-role";

const STATUSES = [
  "invited",
  "setup_required",
  "active",
  "suspended",
  "deactivated",
];

export default async function PeopleListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["admin"]);
  const supabase = await getSupabaseServerClient();
  const membership = await getCurrentMembership(supabase);
  const params = await searchParams;

  const [people, reference] = await Promise.all([
    listPeople(supabase, membership.organizationId),
    getOrgReferenceData(supabase, membership.organizationId),
  ]);

  const q = (params.q ?? "").trim().toLowerCase();
  const filtered = people.filter((person) => {
    if (
      q &&
      !person.displayName.toLowerCase().includes(q) &&
      !person.workEmail.toLowerCase().includes(q)
    ) {
      return false;
    }
    if (params.role && person.roleId !== params.role) return false;
    if (params.manager && person.managerId !== params.manager) return false;
    if (params.team && person.teamId !== params.team) return false;
    if (params.status && person.status !== params.status) return false;
    return true;
  });

  return (
    <main className="flex flex-1 flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight text-[#F5F5F5]">People</h1>
        <Link
          href="/admin/people/new"
          className="rounded-md bg-[#29FE29] px-3 py-2 text-sm font-medium text-[#0B1D33]"
        >
          Add Person
        </Link>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1 text-[#F5F5F5]">
          Search
          <input
            type="text"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Name or email"
            className="rounded-md border border-[#F5F5F5]/10 bg-[#1E1E1E] px-2 py-1.5 text-[#F5F5F5] placeholder:text-[#F5F5F5]/40"
          />
        </label>
        <label className="flex flex-col gap-1 text-[#F5F5F5]">
          Role
          <select
            name="role"
            defaultValue={params.role ?? ""}
            className="rounded-md border border-[#F5F5F5]/10 bg-[#1E1E1E] px-2 py-1.5 text-[#F5F5F5]"
          >
            <option value="">All roles</option>
            {reference.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#F5F5F5]">
          Manager
          <select
            name="manager"
            defaultValue={params.manager ?? ""}
            className="rounded-md border border-[#F5F5F5]/10 bg-[#1E1E1E] px-2 py-1.5 text-[#F5F5F5]"
          >
            <option value="">All managers</option>
            {reference.activeMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#F5F5F5]">
          Team
          <select
            name="team"
            defaultValue={params.team ?? ""}
            className="rounded-md border border-[#F5F5F5]/10 bg-[#1E1E1E] px-2 py-1.5 text-[#F5F5F5]"
          >
            <option value="">All teams</option>
            {reference.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#F5F5F5]">
          Status
          <select
            name="status"
            defaultValue={params.status ?? ""}
            className="rounded-md border border-[#F5F5F5]/10 bg-[#1E1E1E] px-2 py-1.5 text-[#F5F5F5]"
          >
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md border border-[#F5F5F5]/10 px-3 py-1.5 text-[#F5F5F5]"
        >
          Filter
        </button>
        {(params.q ||
          params.role ||
          params.manager ||
          params.team ||
          params.status) && (
          <Link href="/admin/people" className="text-[#F5F5F5]/60 underline">
            Clear
          </Link>
        )}
      </form>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#F5F5F5]/10 text-[#F5F5F5]/60">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Work Email</th>
              <th className="py-2 pr-4">Role</th>
              <th className="py-2 pr-4">Manager</th>
              <th className="py-2 pr-4">Department</th>
              <th className="py-2 pr-4">Team</th>
              <th className="py-2 pr-4">Meeting Intelligence</th>
              <th className="py-2 pr-4">Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((person) => (
              <tr
                key={person.id}
                className="border-b border-[#F5F5F5]/5 text-[#F5F5F5]"
              >
                <td className="py-2 pr-4">
                  <Link
                    href={`/admin/people/${person.id}`}
                    className="font-medium underline"
                  >
                    {person.displayName}
                  </Link>
                </td>
                <td className="py-2 pr-4">{person.workEmail}</td>
                <td className="py-2 pr-4">{person.roleName}</td>
                <td className="py-2 pr-4">{person.managerName ?? "—"}</td>
                <td className="py-2 pr-4">{person.departmentName ?? "—"}</td>
                <td className="py-2 pr-4">{person.teamName ?? "—"}</td>
                <td className="py-2 pr-4">
                  {person.meetingAiEnabled ? "On" : "Off"}
                </td>
                <td className="py-2 pr-4">
                  <span>
                    {person.status}
                    {!person.userLinked ? " (no account yet)" : ""}
                  </span>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-[#F5F5F5]/60">
                  No people match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
