import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLIENT_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

const SERVER_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MICROSOFT_TENANT_ID",
  "MICROSOFT_WEBHOOK_CLIENT_STATE",
  "VEXA_BASE_URL",
  "VEXA_API_KEY",
  "OPENAI_API_KEY",
  "EMAIL_PROVIDER_API_KEY",
  "EMAIL_FROM_ADDRESS",
  "APPLYWIZZ_CRM_BASE_URL",
  "APPLYWIZZ_CRM_API_KEY",
  "APP_BASE_URL",
  "WEBHOOK_BASE_URL",
  "ENCRYPTION_KEY",
] as const;

function setAllEnv() {
  for (const key of [...CLIENT_VARS, ...SERVER_VARS]) {
    process.env[key] = "test-value";
  }
}

function clearAllEnv() {
  for (const key of [...CLIENT_VARS, ...SERVER_VARS]) {
    delete process.env[key];
  }
}

describe("getClientEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    setAllEnv();
  });
  afterEach(clearAllEnv);

  it("returns configured values", async () => {
    const { getClientEnv } = await import("./client");
    expect(getClientEnv().NEXT_PUBLIC_SUPABASE_URL).toBe("test-value");
  });

  it("throws when a required client var is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { getClientEnv } = await import("./client");
    expect(() => getClientEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("server env getters", () => {
  beforeEach(() => {
    vi.resetModules();
    setAllEnv();
  });
  afterEach(() => {
    clearAllEnv();
    // @ts-expect-error cleaning up the simulated browser global from the guard test
    delete globalThis.window;
  });

  it("each getter returns only its own concern's values", async () => {
    const server = await import("./server");
    expect(server.getMicrosoftEnv().MICROSOFT_CLIENT_ID).toBe("test-value");
    expect(server.getEncryptionKey()).toBe("test-value");
    expect(server.getSupabaseServiceRoleKey()).toBe("test-value");
    expect(server.getAppBaseUrl()).toBe("test-value");
  });

  it("a getter fails only when its OWN vars are missing, not unrelated ones", async () => {
    // Simulates M3 calling getMicrosoftEnv() while Vexa/OpenAI/Email/CRM
    // (unrelated future milestones) are still unset.
    delete process.env.VEXA_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.EMAIL_PROVIDER_API_KEY;
    delete process.env.APPLYWIZZ_CRM_API_KEY;
    const { getMicrosoftEnv } = await import("./server");
    expect(() => getMicrosoftEnv()).not.toThrow();
  });

  it("throws when a required var for that getter is missing", async () => {
    delete process.env.MICROSOFT_CLIENT_ID;
    const { getMicrosoftEnv } = await import("./server");
    expect(() => getMicrosoftEnv()).toThrow(/MICROSOFT_CLIENT_ID/);
  });

  it("refuses to load when imported into browser-like code", async () => {
    // @ts-expect-error simulating a browser global to trigger the guard
    globalThis.window = {};
    await expect(import("./server")).rejects.toThrow(
      /must never reach the client bundle/,
    );
  });
});
