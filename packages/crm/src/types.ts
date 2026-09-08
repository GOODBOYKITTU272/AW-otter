import { z } from "zod";

/**
 * STRICT ALLOWLIST — this is the actual privacy enforcement, not just
 * documentation. The real upstream response also includes full address,
 * date of birth, gender, race/ethnicity, veteran status, disability
 * status, felony/background/drug-screen answers, and other EEO/legal
 * data. None of those fields are declared here. A plain Zod `z.object()`
 * strips every key it doesn't declare by default (no `.passthrough()`
 * anywhere in this file) — an unlisted field is not "read and discarded
 * later," it never survives parsing at all. Every field below is
 * genuinely used by normalize.ts; nothing is declared "just in case."
 *
 * Every field except applywizz_id is optional/nullable — "missing
 * optional fields tolerated" (locked requirement). Only applywizz_id
 * (the stable external identity) is required; a response missing it
 * fails validation outright rather than being normalized with a guessed
 * identity.
 */
export const rawCrmClientSchema = z.object({
  applywizz_id: z.string().min(1),
  job_role_preferences: z.array(z.string()).nullish(),
  role: z.string().nullish(),
  salary_range: z.string().nullish(),
  location_preferences: z.array(z.string()).nullish(),
  work_auth_details: z.string().nullish(),
  visa_type: z.string().nullish(),
  sponsorship: z.boolean().nullish(),
  update_at: z.string().nullish(),
});

export const rawCrmAdditionalInfoSchema = z.object({
  resume_url: z.string().nullish(),
  start_date: z.string().nullish(),
  end_date: z.string().nullish(),
  no_of_applications: z.number().nullish(),
  eligible_to_work_in_us: z.boolean().nullish(),
  authorized_without_visa: z.boolean().nullish(),
  require_future_sponsorship: z.boolean().nullish(),
  highest_education: z.string().nullish(),
  university_name: z.string().nullish(),
  willing_to_relocate: z.boolean().nullish(),
  can_work_3_days_in_office: z.boolean().nullish(),
  role: z.string().nullish(),
  experience: z.string().nullish(),
  work_preferences: z.string().nullish(),
  alternate_job_roles: z.string().nullish(),
  exclude_companies: z.string().nullish(),
  github_url: z.string().nullish(),
  linked_in_url: z.string().nullish(),
  client_form_fill_date: z.string().nullish(),
  role_last_updated: z.string().nullish(),
});

/**
 * Top-level envelope. Every field on `client`/`additional_information`
 * NOT declared in the two schemas above (full_name, personal_email,
 * whatsapp_number, callable_phone, company_email, full_address,
 * date_of_birth, gender, race_ethnicity, veteran_status,
 * disability_status, felony/background/drug fields, and anything else
 * the upstream API adds later) is silently stripped by Zod — ignored by
 * default, per the locked "allowlist, not blacklist" rule.
 */
export const rawCrmResponseSchema = z.object({
  client: rawCrmClientSchema,
  additional_information: rawCrmAdditionalInfoSchema.nullish(),
});

export type RawCrmResponse = z.infer<typeof rawCrmResponseSchema>;

/**
 * Signal's own normalized shape — upstream field names never leak past
 * normalize.ts. `truthFields` are the subset that participate in
 * effective-truth precedence against confirmed customer_truth_facts
 * (§11); everything else is CRM context only, never compared/proposed.
 */
export interface NormalizedCrmBaseline {
  truthFields: {
    target_roles: string[] | null;
    alternate_roles: string[] | null;
    locations: string[] | null;
    compensation: string | null;
    work_authorization: string | null;
    sponsorship: boolean | null;
    relocation: boolean | null;
    work_mode: string | null;
    avoid_companies: string[] | null;
  };
  context: {
    resume_url: string | null;
    service_start: string | null;
    service_end: string | null;
    application_count: number | null;
    experience: string | null;
    education_context: string | null;
    upstream_role_updated_at: string | null;
    onboarding_form_submitted_at: string | null;
  };
}

export const TRUTH_FIELD_KEYS = [
  "target_roles",
  "alternate_roles",
  "locations",
  "compensation",
  "work_authorization",
  "sponsorship",
  "relocation",
  "work_mode",
  "avoid_companies",
] as const;
