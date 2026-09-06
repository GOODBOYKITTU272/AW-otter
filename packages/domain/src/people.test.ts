import { describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import {
  CircularReportingError,
  CrossOrganizationAssignmentError,
  DuplicateWorkEmailError,
  SelfManagementError,
  normalizeWorkEmail,
  translatePersonError,
  validateReportingRelationship,
  type AppSupabaseClient,
} from "./people";

function pgError(overrides: Partial<PostgrestError>): PostgrestError {
  return {
    message: "",
    details: "",
    hint: "",
    code: "",
    name: "PostgrestError",
    ...overrides,
  } as PostgrestError;
}

describe("normalizeWorkEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeWorkEmail("  Admin@Example.COM  ")).toBe(
      "admin@example.com",
    );
  });
});

describe("translatePersonError", () => {
  it("maps a unique violation to DuplicateWorkEmailError", () => {
    const error = translatePersonError(
      pgError({ code: "23505", message: "duplicate key" }),
    );
    expect(error).toBeInstanceOf(DuplicateWorkEmailError);
  });

  it("maps the self-management trigger message to SelfManagementError", () => {
    const error = translatePersonError(
      pgError({ code: "P0001", message: "A person cannot manage themselves." }),
    );
    expect(error).toBeInstanceOf(SelfManagementError);
  });

  it("maps the circular-reporting trigger message to CircularReportingError", () => {
    const error = translatePersonError(
      pgError({
        code: "P0001",
        message: "Circular reporting relationship detected.",
      }),
    );
    expect(error).toBeInstanceOf(CircularReportingError);
  });

  it("maps a cross-organization trigger message to CrossOrganizationAssignmentError", () => {
    const error = translatePersonError(
      pgError({
        code: "P0001",
        message: "Manager must belong to the same organization.",
      }),
    );
    expect(error).toBeInstanceOf(CrossOrganizationAssignmentError);
  });

  it("falls back to a plain Error for anything else", () => {
    const error = translatePersonError(
      pgError({ code: "23503", message: "some other failure" }),
    );
    expect(error.message).toBe("some other failure");
    expect(error).not.toBeInstanceOf(DuplicateWorkEmailError);
  });
});

/** Minimal fake for the single-column chain validateReportingRelationship walks. */
function createFakeSupabase(
  chain: Record<string, string | null>,
): AppSupabaseClient {
  return {
    from(_table: string) {
      let queriedId = "";
      const builder = {
        select() {
          return builder;
        },
        eq(_column: string, value: string) {
          queriedId = value;
          return builder;
        },
        async maybeSingle() {
          const managerId = chain[queriedId] ?? null;
          return { data: { manager_membership_id: managerId }, error: null };
        },
      };
      return builder;
    },
  } as unknown as AppSupabaseClient;
}

describe("validateReportingRelationship", () => {
  it("allows a null manager", async () => {
    const supabase = createFakeSupabase({});
    await expect(
      validateReportingRelationship(supabase, "a", null),
    ).resolves.toEqual({
      valid: true,
    });
  });

  it("rejects assigning yourself as your own manager", async () => {
    const supabase = createFakeSupabase({});
    const result = await validateReportingRelationship(supabase, "a", "a");
    expect(result.valid).toBe(false);
  });

  it("allows a simple, non-circular chain", async () => {
    // proposed manager b -> manager c -> no manager
    const supabase = createFakeSupabase({ b: "c", c: null });
    await expect(
      validateReportingRelationship(supabase, "a", "b"),
    ).resolves.toEqual({
      valid: true,
    });
  });

  it("rejects a direct cycle (A -> B, B already reports to A)", async () => {
    // a wants manager b; b's manager is already a
    const supabase = createFakeSupabase({ b: "a" });
    const result = await validateReportingRelationship(supabase, "a", "b");
    expect(result.valid).toBe(false);
  });
});
