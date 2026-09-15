import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";

describe("POST /api/auth/check-user", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 400 for non-@applywizz.ai email addresses", async () => {
    const req = new Request("https://echo.applywizz.ai/api/auth/check-user", {
      method: "POST",
      body: JSON.stringify({ email: "invalid@gmail.com" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Only @applywizz.ai email addresses are permitted.");
  });
});
