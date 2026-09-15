import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

describe("POST /api/auth/send-email", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 400 if recipient email is missing", async () => {
    const req = new Request("https://echo.applywizz.ai/api/auth/send-email", {
      method: "POST",
      body: JSON.stringify({
        user: {},
        email_data: { token: "123456" },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Missing recipient email");
  });

  it("returns 401 if secret verification fails when secret is configured", async () => {
    process.env.SUPABASE_AUTH_HOOK_SECRET = "test-secret";

    const req = new Request("https://echo.applywizz.ai/api/auth/send-email", {
      method: "POST",
      headers: {
        "x-supabase-signature": "wrong-secret",
      },
      body: JSON.stringify({
        user: { email: "test@applywizz.ai" },
        email_data: { token: "123456" },
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(401);
    delete process.env.SUPABASE_AUTH_HOOK_SECRET;
  });
});
