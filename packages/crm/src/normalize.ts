import type { NormalizedCrmBaseline, RawCrmResponse } from "./types";

function dedupeNonEmpty(
  values: (string | null | undefined)[],
): string[] | null {
  const cleaned = values
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  const unique = Array.from(new Set(cleaned));
  return unique.length > 0 ? unique : null;
}

/**
 * `exclude_companies` has been observed as a JSON-encoded string
 * containing a single comma-joined entry (e.g. the literal string
 * `["Adobe,Google,Amazon"]`, not `["Adobe","Google","Amazon"]`) — a real
 * upstream data quirk, not a hypothetical one. Handles both that shape
 * and a plain comma-separated string, and degrades to null rather than
 * throwing on anything else malformed (never lets a formatting quirk in
 * one field fail the whole hydration).
 */
function parseExcludeCompanies(
  raw: string | null | undefined,
): string[] | null {
  if (!raw || raw.trim().length === 0) return null;
  let candidates: string[] = [raw];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      candidates = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // Not JSON — treat the raw string as a plain comma-separated value below.
  }
  return dedupeNonEmpty(candidates.flatMap((entry) => entry.split(",")));
}

function composeWorkAuthorization(
  client: RawCrmResponse["client"],
  info: RawCrmResponse["additional_information"],
): string | null {
  const parts: string[] = [];
  if (client.visa_type) parts.push(`Visa: ${client.visa_type}`);
  if (client.work_auth_details) parts.push(client.work_auth_details);
  if (info?.eligible_to_work_in_us === false)
    parts.push("Not eligible to work in US");
  if (info?.authorized_without_visa === true)
    parts.push("Authorized without visa");
  return parts.length > 0 ? parts.join("; ") : null;
}

function composeWorkMode(
  info: RawCrmResponse["additional_information"],
): string | null {
  const parts: string[] = [];
  if (info?.work_preferences) parts.push(info.work_preferences);
  if (info?.can_work_3_days_in_office === true)
    parts.push("can work 3 days in office");
  return parts.length > 0 ? parts.join("; ") : null;
}

function composeEducationContext(
  info: RawCrmResponse["additional_information"],
): string | null {
  const parts = [info?.highest_education, info?.university_name].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Raw (already Zod-validated, already allowlisted) upstream fields ->
 * Signal's own normalized shape. Never sees or forwards any field
 * outside the allowlist in types.ts — this function's INPUT type already
 * makes that structurally impossible, it isn't relying on this function
 * being careful.
 */
export function normalizeCrmResponse(
  raw: RawCrmResponse,
): NormalizedCrmBaseline {
  const { client, additional_information: info } = raw;

  let sponsorship: boolean | null = null;
  if (
    client.sponsorship === true ||
    info?.require_future_sponsorship === true
  ) {
    sponsorship = true;
  } else if (client.sponsorship === false) {
    sponsorship = false;
  }

  return {
    truthFields: {
      target_roles: dedupeNonEmpty([
        ...(client.job_role_preferences ?? []),
        client.role,
        info?.role,
      ]),
      alternate_roles: info?.alternate_job_roles
        ? dedupeNonEmpty(info.alternate_job_roles.split(","))
        : null,
      locations: dedupeNonEmpty(client.location_preferences ?? []),
      compensation: client.salary_range?.trim() || null,
      work_authorization: composeWorkAuthorization(client, info ?? null),
      sponsorship,
      relocation: info?.willing_to_relocate ?? null,
      work_mode: composeWorkMode(info ?? null),
      avoid_companies: parseExcludeCompanies(info?.exclude_companies),
    },
    context: {
      resume_url: info?.resume_url?.trim() || null,
      service_start: info?.start_date?.trim() || null,
      service_end: info?.end_date?.trim() || null,
      application_count: info?.no_of_applications ?? null,
      experience: info?.experience?.trim() || null,
      education_context: composeEducationContext(info ?? null),
      upstream_role_updated_at: info?.role_last_updated?.trim() || null,
      onboarding_form_submitted_at: info?.client_form_fill_date?.trim() || null,
    },
  };
}
