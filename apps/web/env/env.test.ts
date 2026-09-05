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

describe("getServerEnv", () => {
  beforeEach(() => {
    vi.resetModules();
    setAllEnv();
  });
  afterEach(() => {
    clearAllEnv();
    // @ts-expect-error cleaning up the simulated browser global from the guard test
    delete globalThis.window;
  });

  it("returns configured values", async () => {
    const { getServerEnv } = await import("./server");
    expect(getServerEnv().OPENAI_API_KEY).toBe("test-value");
  });

  it("throws when a required server var is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const { getServerEnv } = await import("./server");
    expect(() => getServerEnv()).toThrow(/OPENAI_API_KEY/);
  });

  it("refuses to load when imported into browser-like code", async () => {
    // @ts-expect-error simulating a browser global to trigger the guard
    globalThis.window = {};
    await expect(import("./server")).rejects.toThrow(
      /must never reach the client bundle/,
    );
  });
});
