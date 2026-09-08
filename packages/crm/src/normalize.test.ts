import { describe, expect, it } from "vitest";
import { normalizeCrmResponse } from "./normalize";
import type { RawCrmResponse } from "./types";

// All values below are synthetic fixtures — never real customer data.
function fixture(overrides: Partial<RawCrmResponse> = {}): RawCrmResponse {
  return {
    client: {
      applywizz_id: "AWL-00000",
      job_role_preferences: ["Backend Engineer"],
      role: "Backend Engineer",
      salary_range: "USD Yearly: 90k-110k",
      location_preferences: ["Austin", "Dallas"],
      work_auth_details: "Over 18: yes, Eligible in US: yes",
      visa_type: "F1",
      sponsorship: true,
      update_at: "2026-08-01T00:00:00.000Z",
      ...overrides.client,
    },
    additional_information: {
      resume_url: "https://example.test/resume.pdf",
      start_date: "2026-08-01",
      end_date: "2026-09-01",
      no_of_applications: 10,
      eligible_to_work_in_us: true,
      authorized_without_visa: false,
      require_future_sponsorship: true,
      highest_education: "Master's Degree",
      university_name: "Test University",
      willing_to_relocate: true,
      can_work_3_days_in_office: true,
      role: "Backend Engineer",
      experience: "4",
      work_preferences: "Hybrid",
      alternate_job_roles: "platform engineer, sre",
      exclude_companies: '["CompanyA,CompanyB"]',
      github_url: "https://github.test/user",
      linked_in_url: "linkedin.test/in/user",
      client_form_fill_date: "2026-07-30T00:00:00.000Z",
      role_last_updated: "2026-08-01T00:00:00.000Z",
      ...overrides.additional_information,
    },
  };
}

describe("normalizeCrmResponse", () => {
  it("merges and dedupes target_roles from job_role_preferences/role/additional_information.role", () => {
    const result = normalizeCrmResponse(fixture());
    expect(result.truthFields.target_roles).toEqual(["Backend Engineer"]);
  });

  it("splits alternate_job_roles on commas", () => {
    const result = normalizeCrmResponse(fixture());
    expect(result.truthFields.alternate_roles).toEqual([
      "platform engineer",
      "sre",
    ]);
  });

  it("parses exclude_companies' real observed quirk (JSON-encoded single comma-joined string)", () => {
    const result = normalizeCrmResponse(fixture());
    expect(result.truthFields.avoid_companies).toEqual([
      "CompanyA",
      "CompanyB",
    ]);
  });

  it("falls back to plain comma-split when exclude_companies isn't JSON", () => {
    const result = normalizeCrmResponse(
      fixture({
        additional_information: {
          ...fixture().additional_information,
          exclude_companies: "CompanyA,CompanyB",
        },
      }),
    );
    expect(result.truthFields.avoid_companies).toEqual([
      "CompanyA",
      "CompanyB",
    ]);
  });

  it("treats sponsorship as true if EITHER client.sponsorship or require_future_sponsorship is true", () => {
    const result = normalizeCrmResponse(
      fixture({
        client: { ...fixture().client, sponsorship: false },
        additional_information: {
          ...fixture().additional_information,
          require_future_sponsorship: true,
        },
      }),
    );
    expect(result.truthFields.sponsorship).toBe(true);
  });

  it("composes work_authorization from visa_type + work_auth_details", () => {
    const result = normalizeCrmResponse(fixture());
    expect(result.truthFields.work_authorization).toContain("F1");
  });

  it("returns null (not throw) for a field entirely absent from the input", () => {
    const result = normalizeCrmResponse(
      fixture({
        client: { ...fixture().client, salary_range: undefined },
      }),
    );
    expect(result.truthFields.compensation).toBeNull();
  });

  it("tolerates a completely missing additional_information block", () => {
    const raw = fixture();
    const result = normalizeCrmResponse({
      client: raw.client,
      additional_information: null,
    });
    expect(result.truthFields.relocation).toBeNull();
    expect(result.context.resume_url).toBeNull();
  });

  it("puts context fields (resume_url, dates, experience) under context, not truthFields", () => {
    const result = normalizeCrmResponse(fixture());
    expect(result.context.resume_url).toBe("https://example.test/resume.pdf");
    expect(result.context.application_count).toBe(10);
    expect(
      (result.truthFields as Record<string, unknown>).resume_url,
    ).toBeUndefined();
  });
});
