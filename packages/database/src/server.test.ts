import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("database/server", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // @ts-expect-error cleaning up the simulated browser global
    delete globalThis.window;
  });

  it("exposes the server and service-role client factories", async () => {
    const mod = await import("./server");
    expect(typeof mod.createSupabaseServerClient).toBe("function");
    expect(typeof mod.createSupabaseServiceRoleClient).toBe("function");
  });

  it("refuses to load when imported into browser-like code", async () => {
    // @ts-expect-error simulating a browser global to trigger the guard
    globalThis.window = {};
    await expect(import("./server")).rejects.toThrow(
      /must never reach the client bundle/,
    );
  });
});
