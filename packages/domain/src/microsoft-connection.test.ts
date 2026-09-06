import { describe, expect, it, vi } from "vitest";
import { encryptToken } from "@applywizz/microsoft";
import {
  completeMicrosoftConnection,
  getConnectionStatus,
  getValidAccessToken,
  type AppSupabaseClient,
} from "./microsoft-connection";

type Handlers = Record<
  string,
  {
    select?: (filters: Record<string, unknown>) => {
      data: unknown;
      error: unknown;
    };
    insert?: (payload: unknown) => { data: unknown; error: unknown };
    upsert?: (payload: unknown) => { data: unknown; error: unknown };
    update?: (
      payload: unknown,
      filters: Record<string, unknown>,
    ) => { data: unknown; error: unknown };
  }
>;

/**
 * Minimal fake covering only the chain shapes microsoft-connection.ts
 * actually issues (select/insert/upsert/update, each optionally followed by
 * .eq()/.order()/.limit()/.select()/.single()/.maybeSingle(), or awaited
 * directly). Cross-org/RLS enforcement itself is proven separately by the
 * M3 pgTAP suite against real Postgres — this only tests this file's own
 * orchestration logic.
 */
function createFakeSupabase(handlers: Handlers): AppSupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let op: {
      type: "select" | "insert" | "upsert" | "update";
      payload?: unknown;
    } = {
      type: "select",
    };

    function resolve() {
      const h = handlers[table] ?? {};
      if (op.type === "insert" && h.insert) return h.insert(op.payload);
      if (op.type === "upsert" && h.upsert) return h.upsert(op.payload);
      if (op.type === "update" && h.update)
        return h.update(op.payload, filters);
      if (h.select) return h.select(filters);
      return { data: null, error: null };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(payload: unknown) {
        op = { type: "insert", payload };
        return builder;
      },
      upsert(payload: unknown) {
        op = { type: "upsert", payload };
        return builder;
      },
      update(payload: unknown) {
        op = { type: "update", payload };
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        return resolve();
      },
      async single() {
        return resolve();
      },
      then(
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(resolve()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { from } as unknown as AppSupabaseClient;
}

function fakeGraphFetch(
  responses: Record<string, { status: number; body: unknown }>,
) {
  return async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [match, response] of Object.entries(responses)) {
      if (url.includes(match)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    throw new Error(`Unexpected fetch to ${url}`);
  };
}

function makeIdToken(payload: Record<string, unknown>): string {
  const base64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${base64url({ alg: "none" })}.${base64url(payload)}.sig`;
}

describe("getConnectionStatus", () => {
  it("reports not_connected when no row exists", async () => {
    const supabase = createFakeSupabase({
      calendar_connections: { select: () => ({ data: null, error: null }) },
    });
    await expect(getConnectionStatus(supabase, "m1")).resolves.toEqual({
      status: "not_connected",
      providerEmail: null,
      lastSyncAt: null,
      subscription: null,
    });
  });

  it("reports the connection and latest subscription when present", async () => {
    const supabase = createFakeSupabase({
      calendar_connections: {
        select: () => ({
          data: {
            id: "conn-1",
            status: "active",
            last_sync_at: "2026-09-01T00:00:00Z",
            scope_metadata: { email: "ada@applywizz.test" },
          },
          error: null,
        }),
      },
      provider_subscriptions: {
        select: () => ({
          data: { status: "active", expires_at: "2026-09-05T00:00:00Z" },
          error: null,
        }),
      },
    });

    await expect(getConnectionStatus(supabase, "m1")).resolves.toEqual({
      status: "active",
      providerEmail: "ada@applywizz.test",
      lastSyncAt: "2026-09-01T00:00:00Z",
      subscription: { status: "active", expiresAt: "2026-09-05T00:00:00Z" },
    });
  });
});

describe("getValidAccessToken", () => {
  const microsoftEnv = {
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    webhookClientState: "cs",
  };

  it("returns the decrypted token without refreshing when far from expiry", async () => {
    const encrypted = encryptToken("valid-access-token", "key");
    const supabase = createFakeSupabase({
      calendar_connection_secrets: {
        select: () => ({
          data: {
            encrypted_access_token: encrypted,
            encrypted_refresh_token: null,
            access_token_expires_at: new Date(
              Date.now() + 60 * 60 * 1000,
            ).toISOString(),
          },
          error: null,
        }),
      },
    });

    const token = await getValidAccessToken(
      supabase,
      "conn-1",
      microsoftEnv,
      "key",
    );
    expect(token).toBe("valid-access-token");
  });

  it("refreshes and persists new tokens when near expiry", async () => {
    const encryptedRefresh = encryptToken("old-refresh-token", "key");
    const updateSpy = vi.fn(() => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      calendar_connection_secrets: {
        select: () => ({
          data: {
            encrypted_access_token: encryptToken("stale-token", "key"),
            encrypted_refresh_token: encryptedRefresh,
            access_token_expires_at: new Date(
              Date.now() + 60 * 1000,
            ).toISOString(),
          },
          error: null,
        }),
        update: updateSpy,
      },
    });

    const token = await getValidAccessToken(
      supabase,
      "conn-1",
      microsoftEnv,
      "key",
      fakeGraphFetch({
        "/oauth2/v2.0/token": {
          status: 200,
          body: { access_token: "fresh-token", expires_in: 3600 },
        },
      }),
    );

    expect(token).toBe("fresh-token");
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when the token is expired and there is no refresh token", async () => {
    const supabase = createFakeSupabase({
      calendar_connection_secrets: {
        select: () => ({
          data: {
            encrypted_access_token: encryptToken("stale-token", "key"),
            encrypted_refresh_token: null,
            access_token_expires_at: new Date(Date.now() - 1000).toISOString(),
          },
          error: null,
        }),
      },
    });

    await expect(
      getValidAccessToken(supabase, "conn-1", microsoftEnv, "key"),
    ).rejects.toThrow(/no refresh token/);
  });
});

describe("completeMicrosoftConnection", () => {
  const microsoftEnv = {
    tenantId: "t",
    clientId: "c",
    clientSecret: "s",
    webhookClientState: "cs",
  };
  const idToken = makeIdToken({
    oid: "ms-oid-1",
    email: "ada@applywizz.test",
    name: "Ada",
  });

  function baseSupabase(overrides: Partial<Handlers> = {}) {
    return createFakeSupabase({
      calendar_connections: {
        upsert: () => ({ data: { id: "conn-1" }, error: null }),
        update: () => ({ data: null, error: null }),
      },
      provider_subscriptions: {
        insert: () => ({ data: { id: "sub-row-1" }, error: null }),
      },
      calendar_sync_cursors: { upsert: () => ({ data: null, error: null }) },
      audit_events: { insert: () => ({ data: null, error: null }) },
      ...overrides,
    });
  }

  const serviceRoleClient = createFakeSupabase({
    calendar_connection_secrets: {
      upsert: () => ({ data: null, error: null }),
    },
  });

  it("completes the happy path: connection, subscription, and initial sync all succeed", async () => {
    const fetchImpl = fakeGraphFetch({
      "/oauth2/v2.0/token": {
        status: 200,
        body: {
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          id_token: idToken,
        },
      },
      "/subscriptions": {
        status: 201,
        body: {
          id: "sub-1",
          resource: "me/events",
          expirationDateTime: "2026-09-10T00:00:00Z",
        },
      },
      "/me/calendarView": {
        status: 200,
        body: {
          value: [
            {
              id: "e1",
              isOnlineMeeting: true,
              onlineMeetingProvider: "teamsForBusiness",
            },
            { id: "e2", isOnlineMeeting: false },
          ],
        },
      },
    });

    const result = await completeMicrosoftConnection(
      baseSupabase(),
      serviceRoleClient,
      {
        organizationId: "org-1",
        membershipId: "m1",
        actorUserId: "u1",
        code: "auth-code",
        redirectUri: "https://app.example.com/callback",
        webhookUrl: "https://app.example.com/api/webhooks/microsoft/calendar",
        microsoftEnv,
        encryptionKey: "key",
        fetchImpl,
      },
    );

    expect(result).toEqual({
      connectionId: "conn-1",
      eventsRead: 2,
      teamsEventsDetected: 1,
      subscriptionCreated: true,
      initialSyncSucceeded: true,
      warnings: [],
    });
  });

  it("reports a warning (not a thrown error) when subscription creation fails", async () => {
    const fetchImpl = fakeGraphFetch({
      "/oauth2/v2.0/token": {
        status: 200,
        body: { access_token: "at", expires_in: 3600, id_token: idToken },
      },
      "/subscriptions": {
        status: 500,
        body: { error: { code: "ServiceError", message: "down" } },
      },
      "/me/calendarView": { status: 200, body: { value: [] } },
    });

    const result = await completeMicrosoftConnection(
      baseSupabase(),
      serviceRoleClient,
      {
        organizationId: "org-1",
        membershipId: "m1",
        actorUserId: "u1",
        code: "auth-code",
        redirectUri: "https://app.example.com/callback",
        webhookUrl: "https://app.example.com/api/webhooks/microsoft/calendar",
        microsoftEnv,
        encryptionKey: "key",
        fetchImpl,
      },
    );

    expect(result.subscriptionCreated).toBe(false);
    expect(result.initialSyncSucceeded).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("subscription");
  });

  it("throws (no connection at all) when the code exchange itself fails", async () => {
    const fetchImpl = fakeGraphFetch({
      "/oauth2/v2.0/token": {
        status: 401,
        body: { error: { code: "invalid_grant" } },
      },
    });

    await expect(
      completeMicrosoftConnection(baseSupabase(), serviceRoleClient, {
        organizationId: "org-1",
        membershipId: "m1",
        actorUserId: "u1",
        code: "bad-code",
        redirectUri: "https://app.example.com/callback",
        webhookUrl: "https://app.example.com/api/webhooks/microsoft/calendar",
        microsoftEnv,
        encryptionKey: "key",
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
