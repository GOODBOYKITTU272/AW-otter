"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { OrgReferenceData } from "@/lib/people-queries";

export function AddPersonForm({ reference }: { reference: OrgReferenceData }) {
  const router = useRouter();
  const [workEmail, setWorkEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [managerId, setManagerId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [meetingAiEnabled, setMeetingAiEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const visibleTeams = useMemo(() => {
    if (!departmentId) return reference.teams;
    return reference.teams.filter(
      (team) =>
        team.departmentId === null || team.departmentId === departmentId,
    );
  }, [departmentId, reference.teams]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const response = await fetch("/api/people", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workEmail,
        displayName,
        roleId,
        managerMembershipId: managerId || null,
        departmentId: departmentId || null,
        teamId: teamId || null,
        meetingAiEnabled,
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not create this person.");
      setSubmitting(false);
      return;
    }

    const { person, inviteWarning } = await response.json();
    if (inviteWarning) window.alert(inviteWarning);
    router.push(`/admin/people/${person.id}`);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-w-lg flex-col gap-4 text-sm"
    >
      <label className="flex flex-col gap-1 text-zinc-900">
        Work Email
        <input
          type="email"
          required
          value={workEmail}
          onChange={(event) => setWorkEmail(event.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
        />
      </label>

      <label className="flex flex-col gap-1 text-zinc-900">
        Display Name
        <input
          type="text"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 placeholder:text-zinc-400"
        />
      </label>

      <label className="flex flex-col gap-1 text-zinc-900">
        Role
        <select
          required
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900"
        >
          <option value="" disabled>
            Select a role
          </option>
          {reference.roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-zinc-900">
        Manager
        <select
          value={managerId}
          onChange={(event) => setManagerId(event.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900"
        >
          <option value="">No manager</option>
          {reference.activeMembers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-zinc-900">
        Department
        <select
          value={departmentId}
          onChange={(event) => {
            setDepartmentId(event.target.value);
            setTeamId("");
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900"
        >
          <option value="">No department</option>
          {reference.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-zinc-900">
        Team
        <select
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900"
        >
          <option value="">No team</option>
          {visibleTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2 text-zinc-900">
        <input
          type="checkbox"
          checked={meetingAiEnabled}
          onChange={(event) => setMeetingAiEnabled(event.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block font-medium">Meeting Intelligence</span>
          <span className="block text-zinc-600">
            When enabled, eligible meetings for this person can later be
            automatically processed by ApplyWizz Signal according to company
            policy.
          </span>
        </span>
      </label>

      {error ? (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded-md bg-[#29FE29] px-4 py-2 font-medium text-[#0B1D33] disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/admin/people")}
          disabled={submitting}
          className="w-fit rounded-md border border-zinc-300 px-4 py-2 font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
