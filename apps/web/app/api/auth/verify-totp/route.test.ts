import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

describe("POST /api/auth/verify-totp", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 400 for non-@applywizz.ai email addresses", async () => {
    const req = new Request("https://echo.applywizz.ai/api/auth/verify-totp", {
      method: "POST",
      body: JSON.stringify({ email: "invalid@gmail.com", code: "123456" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Only @applywizz.ai email addresses are permitted.");
  });

  it("returns 400 if code is missing or not 6 digits", async () => {
    const req = new Request("https://echo.applywizz.ai/api/auth/verify-totp", {
      method: "POST",
      body: JSON.stringify({ email: "test@applywizz.ai", code: "12" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Please enter the complete 6-digit Authenticator code.");
  });
});
