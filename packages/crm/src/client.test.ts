import { describe, expect, it, vi } from "vitest";
import { getCustomerDetails } from "./client";
import {
  CrmApiError,
  CrmMalformedResponseError,
  CrmProviderMisuseError,
  CrmTimeoutError,
} from "./errors";

// Synthetic fixture only — deliberately includes fields from the
// forbidden list (full_name, personal_email, date_of_birth, gender,
// race_ethnicity, full_address) to prove they are actually stripped, not
// just documented as "shouldn't be there."
function syntheticUpstreamBody() {
  return {
    client: {
      id: "synthetic-uuid",
      full_name: "Synthetic Test Person",
      personal_email: "synthetic@example.test",
      applywizz_id: "AWL-00000",
      job_role_preferences: ["Backend Engineer"],
      salary_range: "USD Yearly: 90k-110k",
      location_preferences: ["Austin"],
      sponsorship: true,
    },
    additional_information: {
      resume_url: "https://example.test/resume.pdf",
      full_address: "123 Synthetic St, Test City, TX",
      date_of_birth: "2000-01-01",
      gender: "unspecified",
      race_ethnicity: "unspecified",
      willing_to_relocate: true,
    },
  };
}

describe("getCustomerDetails", () => {
  it("fetches, validates, and normalizes, returning ONLY allowlisted fields", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("applywizz_id=AWL-00000");
      return new Response(JSON.stringify(syntheticUpstreamBody()), {
        status: 200,
      });
    });

    const result = await getCustomerDetails(
      "https://crm.example.test",
      "AWL-00000",
      null,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.normalized.truthFields.target_roles).toEqual([
      "Backend Engineer",
    ]);
    expect(result.normalized.context.resume_url).toBe(
      "https://example.test/resume.pdf",
    );
    // The forbidden fields must not survive anywhere in the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Synthetic Test Person");
    expect(serialized).not.toContain("synthetic@example.test");
    expect(serialized).not.toContain("123 Synthetic St");
    expect(serialized).not.toContain("2000-01-01");
  });

  it("throws CrmMalformedResponseError when applywizz_id is missing", async () => {
    const fetchImpl = vi.fn(async () => {
      const body = syntheticUpstreamBody();
      // @ts-expect-error deliberately malformed for the test
      delete body.client.applywizz_id;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    await expect(
      getCustomerDetails(
        "https://crm.example.test",
        "AWL-00000",
        null,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(CrmMalformedResponseError);
  });

  it("tolerates missing optional fields", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ client: { applywizz_id: "AWL-00000" } }),
          { status: 200 },
        ),
    );
    const result = await getCustomerDetails(
      "https://crm.example.test",
      "AWL-00000",
      null,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.normalized.truthFields.target_roles).toBeNull();
  });

  it("throws CrmProviderMisuseError for an empty applywizz_id — never sent upstream", async () => {
    const fetchImpl = vi.fn();
    await expect(
      getCustomerDetails(
        "https://crm.example.test",
        "  ",
        null,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(CrmProviderMisuseError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws CrmApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 404 }));
    await expect(
      getCustomerDetails(
        "https://crm.example.test",
        "AWL-00000",
        null,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(CrmApiError);
  });

  it("throws CrmTimeoutError when the request aborts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    await expect(
      getCustomerDetails(
        "https://crm.example.test",
        "AWL-00000",
        null,
        fetchImpl as unknown as typeof fetch,
        20,
      ),
    ).rejects.toBeInstanceOf(CrmTimeoutError);
  });

  it("never includes the API key in any thrown error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 401 }));
    try {
      await getCustomerDetails(
        "https://crm.example.test",
        "AWL-00000",
        "super-secret-key-value",
        fetchImpl as unknown as typeof fetch,
      );
      throw new Error("expected getCustomerDetails to reject");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-key-value");
    }
  });

  it("sends the API key as a Bearer header when provided", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer real-key");
      return new Response(JSON.stringify(syntheticUpstreamBody()), {
        status: 200,
      });
    });
    await getCustomerDetails(
      "https://crm.example.test",
      "AWL-00000",
      "real-key",
      fetchImpl as unknown as typeof fetch,
    );
  });
});
