"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { OrgReferenceData, PersonRow } from "@/lib/people-queries";

export function EditPersonForm({
  person,
  reference,
}: {
  person: PersonRow;
  reference: OrgReferenceData;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(person.displayName);
  const [roleId, setRoleId] = useState(person.roleId);
  const [managerId, setManagerId] = useState(person.managerId ?? "");
  const [departmentId, setDepartmentId] = useState(person.departmentId ?? "");
  const [teamId, setTeamId] = useState(person.teamId ?? "");
  const [meetingAiEnabled, setMeetingAiEnabled] = useState(
    person.meetingAiEnabled,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  const selectableManagers = useMemo(
    () => reference.activeMembers.filter((member) => member.id !== person.id),
    [reference.activeMembers, person.id],
  );

  const visibleTeams = useMemo(() => {
    if (!departmentId) return reference.teams;
    return reference.teams.filter(
      (team) =>
        team.departmentId === null || team.departmentId === departmentId,
    );
  }, [departmentId, reference.teams]);

  async function submitPatch(body: Record<string, unknown>) {
    setError(null);
    const response = await fetch(`/api/people/${person.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      setError(responseBody.error ?? "Could not save this change.");
      return false;
    }
    return true;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");
    const ok = await submitPatch({
      displayName,
      roleId,
      managerMembershipId: managerId || null,
      departmentId: departmentId || null,
      teamId: teamId || null,
      meetingAiEnabled,
    });
    setStatus(ok ? "saved" : "idle");
    if (ok) router.refresh();
  }

  async function handleDeactivate() {
    if (
      !window.confirm(
        `Deactivate ${person.displayName}? This does not delete their record.`,
      )
    ) {
      return;
    }
    setStatus("saving");
    const ok = await submitPatch({ status: "deactivated" });
    setStatus(ok ? "saved" : "idle");
    if (ok) router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-w-lg flex-col gap-4 text-sm"
    >
      <label className="flex flex-col gap-1">
        Display Name
        <input
          type="text"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>

      <label className="flex flex-col gap-1">
        Role
        <select
          required
          value={roleId}
          onChange={(event) => setRoleId(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          {reference.roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        Manager
        <select
          value={managerId}
          onChange={(event) => setManagerId(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">No manager</option>
          {selectableManagers.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        Department
        <select
          value={departmentId}
          onChange={(event) => {
            setDepartmentId(event.target.value);
            setTeamId("");
          }}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">No department</option>
          {reference.departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        Team
        <select
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">No team</option>
          {visibleTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={meetingAiEnabled}
          onChange={(event) => setMeetingAiEnabled(event.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block font-medium">Meeting Intelligence</span>
          <span className="block text-zinc-500 dark:text-zinc-400">
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
      {status === "saved" && !error ? (
        <p className="text-green-700">Saved.</p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={status === "saving"}
          className="w-fit rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900"
        >
          {status === "saving" ? "Saving…" : "Save changes"}
        </button>

        {person.status !== "deactivated" && (
          <button
            type="button"
            onClick={handleDeactivate}
            disabled={status === "saving"}
            className="w-fit rounded-md border border-red-300 px-4 py-2 font-medium text-red-700 disabled:opacity-50"
          >
            Deactivate
          </button>
        )}
      </div>
    </form>
  );
}
