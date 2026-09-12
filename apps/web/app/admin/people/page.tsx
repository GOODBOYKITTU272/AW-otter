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
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1E1E1E]">Team</h1>
          <p className="text-sm text-zinc-600 mt-1">
            Manage people, roles, and Meeting AI settings
          </p>
        </div>
        <Link
          href="/admin/people/new"
          className="rounded-md bg-[#29FE29] px-4 py-2 text-sm font-medium text-[#0B1D33] hover:bg-[#29FE29]/90 transition-colors"
        >
          Add Person
        </Link>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm bg-white border border-zinc-200 rounded-lg p-4">
        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Search
          <input
            type="text"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Name or email"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E] placeholder:text-zinc-400"
          />
        </label>
        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Role
          <select
            name="role"
            defaultValue={params.role ?? ""}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E]"
          >
            <option value="">All roles</option>
            {reference.roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Manager
          <select
            name="manager"
            defaultValue={params.manager ?? ""}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E]"
          >
            <option value="">All managers</option>
            {reference.activeMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Team
          <select
            name="team"
            defaultValue={params.team ?? ""}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E]"
          >
            <option value="">All teams</option>
            {reference.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[#1E1E1E]">
          Status
          <select
            name="status"
            defaultValue={params.status ?? ""}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-[#1E1E1E]"
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
          className="rounded-md border border-zinc-300 bg-white px-4 py-1.5 text-[#1E1E1E] hover:bg-zinc-50 transition-colors"
        >
          Filter
        </button>
        {(params.q ||
          params.role ||
          params.manager ||
          params.team ||
          params.status) && (
          <Link href="/admin/people" className="text-[#2C76FF] hover:underline">
            Clear
          </Link>
        )}
      </form>

      <div className="overflow-x-auto bg-white border border-zinc-200 rounded-lg">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50">
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Name</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Work Email</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Role</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Reports To</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Department</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Team</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Meeting AI</th>
              <th className="px-6 py-3 text-xs font-medium text-zinc-600 uppercase tracking-wider">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((person) => (
              <tr
                key={person.id}
                className="hover:bg-zinc-50 transition-colors"
              >
                <td className="px-6 py-4">
                  <Link
                    href={`/admin/people/${person.id}`}
                    className="font-medium text-[#2C76FF] hover:underline"
                  >
                    {person.displayName}
                  </Link>
                </td>
                <td className="px-6 py-4 text-zinc-600">{person.workEmail}</td>
                <td className="px-6 py-4 text-zinc-900">{person.roleName}</td>
                <td className="px-6 py-4 text-zinc-600">{person.managerName ?? "—"}</td>
                <td className="px-6 py-4 text-zinc-600">{person.departmentName ?? "—"}</td>
                <td className="px-6 py-4 text-zinc-600">{person.teamName ?? "—"}</td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                    person.meetingAiEnabled 
                      ? 'bg-[#29FE29]/10 text-[#166534] border border-[#29FE29]/20' 
                      : 'bg-zinc-100 text-zinc-600 border border-zinc-200'
                  }`}>
                    {person.meetingAiEnabled ? "Enabled" : "Disabled"}
                  </span>
                </td>
                <td className="px-6 py-4 text-zinc-600">
                  {person.status}
                  {!person.userLinked ? " (no account)" : ""}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-6 py-12 text-center text-zinc-500">
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
