import { describe, expect, it } from "vitest";
import {
  ForbiddenError,
  NoActiveMembershipError,
  UnauthenticatedError,
  getCurrentMembership,
  requireAuthenticatedUser,
  requirePermission,
  type AppSupabaseClient,
} from "./index";

interface Fixture {
  user: { id: string; email?: string } | null;
  membership?: {
    id: string;
    organization_id: string;
    role_id: string;
    display_name: string;
  };
  role?: { key: string };
  grantedPermissions?: string[];
}

/**
 * A minimal fake satisfying only the query shapes this package actually
 * issues (select → eq → [eq] → maybeSingle). This tests the branching logic
 * in packages/auth in isolation; RLS enforcement itself is proven separately
 * by the pgTAP tests in supabase/tests against a real Postgres instance.
 */
function createFakeSupabase(fixture: Fixture): AppSupabaseClient {
  function table(name: string) {
    const filters: Record<string, unknown> = {};
    const builder = {
      select() {
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      async maybeSingle() {
        if (name === "organization_memberships") {
          if (!fixture.membership || filters.user_id !== fixture.user?.id) {
            return { data: null, error: null };
          }
          return { data: fixture.membership, error: null };
        }
        if (name === "roles") {
          if (!fixture.role || filters.id !== fixture.membership?.role_id) {
            return { data: null, error: null };
          }
          return { data: fixture.role, error: null };
        }
        if (name === "role_permissions") {
          const granted = (fixture.grantedPermissions ?? []).includes(
            filters.permission_key as string,
          );
          return {
            data: granted ? { permission_key: filters.permission_key } : null,
            error: null,
          };
        }
        throw new Error(`unexpected table in fake: ${name}`);
      },
    };
    return builder;
  }

  return {
    auth: {
      async getUser() {
        return {
          data: { user: fixture.user },
          error: fixture.user ? null : new Error("no user"),
        };
      },
    },
    from: table,
  } as unknown as AppSupabaseClient;
}

describe("requireAuthenticatedUser", () => {
  it("returns the user when signed in", async () => {
    const supabase = createFakeSupabase({ user: { id: "u1" } });
    await expect(requireAuthenticatedUser(supabase)).resolves.toMatchObject({
      id: "u1",
    });
  });

  it("throws UnauthenticatedError when signed out", async () => {
    const supabase = createFakeSupabase({ user: null });
    await expect(requireAuthenticatedUser(supabase)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe("getCurrentMembership", () => {
  it("resolves membership and role for an active member", async () => {
    const supabase = createFakeSupabase({
      user: { id: "u1" },
      membership: {
        id: "m1",
        organization_id: "org1",
        role_id: "r1",
        display_name: "Ada",
      },
      role: { key: "admin" },
    });

    await expect(getCurrentMembership(supabase)).resolves.toMatchObject({
      membershipId: "m1",
      organizationId: "org1",
      roleKey: "admin",
    });
  });

  it("throws NoActiveMembershipError when there is no active membership", async () => {
    const supabase = createFakeSupabase({ user: { id: "u1" } });
    await expect(getCurrentMembership(supabase)).rejects.toBeInstanceOf(
      NoActiveMembershipError,
    );
  });

  it("throws UnauthenticatedError before checking membership when signed out", async () => {
    const supabase = createFakeSupabase({ user: null });
    await expect(getCurrentMembership(supabase)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe("requirePermission", () => {
  it("resolves membership when the role has the permission", async () => {
    const supabase = createFakeSupabase({
      user: { id: "u1" },
      membership: {
        id: "m1",
        organization_id: "org1",
        role_id: "r1",
        display_name: "Ada",
      },
      role: { key: "admin" },
      grantedPermissions: ["organization.manage"],
    });

    await expect(
      requirePermission(supabase, "organization.manage"),
    ).resolves.toMatchObject({
      membershipId: "m1",
    });
  });

  it("throws ForbiddenError when the role lacks the permission", async () => {
    const supabase = createFakeSupabase({
      user: { id: "u1" },
      membership: {
        id: "m1",
        organization_id: "org1",
        role_id: "r1",
        display_name: "Alex",
      },
      role: { key: "account_manager" },
      grantedPermissions: ["meetings.read"],
    });

    await expect(
      requirePermission(supabase, "organization.manage"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
