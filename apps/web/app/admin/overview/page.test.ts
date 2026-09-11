import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/components/upcoming-meetings", () => ({
  UpcomingMeetings: () => React.createElement("div", { "data-testid": "upcoming-meetings" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: vi.fn(),
}));

vi.mock("@/env/server", () => ({
  getAzureMaiEnv: vi.fn(),
}));

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAzureMaiEnv } from "@/env/server";
import AdminOverviewPage from "./page";

describe("AdminOverviewPage honest health status", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  it("source code never hardcodes 'Healthy' or tone='success' for Azure Speech or OpenRouter", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./page.tsx", import.meta.url)),
      "utf8",
    );

    // Ensure neither Azure nor OpenRouter have hardcoded 'Healthy' or tone="success"
    expect(source).not.toContain('Azure Speech (Primary Transcriber)</span>\n              <StatusBadge tone="success">');
    expect(source).not.toContain('OpenRouter Whisper Fallback</span>\n              <StatusBadge tone="success">');
    expect(source).not.toMatch(/Azure Speech[^}]+>Healthy<\/StatusBadge>/);
    expect(source).not.toMatch(/OpenRouter[^}]+>Healthy<\/StatusBadge>/);
    expect(source).not.toMatch(/Azure Speech[^}]+>Ready<\/StatusBadge>/);
    expect(source).not.toMatch(/OpenRouter[^}]+>Ready<\/StatusBadge>/);

    // Ensure honest status text is used
    expect(source).toContain("Configured (Not verified)");
    expect(source).toContain("Not configured / Unknown");
  });

  it("displays 'Configured (Not verified)' and neutral tone when API credentials exist", async () => {
    vi.mocked(getAzureMaiEnv).mockReturnValue({
      isConfigured: true,
      AZURE_MAI_ENDPOINT: "https://mock.azure.com",
      AZURE_MAI_KEY: "secret",
      AZURE_MAI_REGION: "eastus",
    });
    process.env.OPENROUTER_API_KEY = "sk-mock-key";

    vi.mocked(getSupabaseServerClient).mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockResolvedValue({ data: [] }),
        eq: vi.fn().mockResolvedValue({ count: 0 }),
        maybeSingle: vi.fn().mockResolvedValue({ data: { id: "m365", status: "active" } }),
      }),
    } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);

    const jsx = await AdminOverviewPage();
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Azure Speech (Primary Transcriber)");
    expect(html).toContain("OpenRouter Whisper Fallback");
    expect(html).toContain("Configured (Not verified)");
    expect(html).not.toContain(">Healthy<");
    expect(html).not.toContain(">Ready<");
  });

  it("displays 'Not configured / Unknown' and warning tone when API credentials are absent", async () => {
    vi.mocked(getAzureMaiEnv).mockReturnValue({
      isConfigured: false,
      AZURE_MAI_ENDPOINT: undefined,
      AZURE_MAI_KEY: undefined,
      AZURE_MAI_REGION: undefined,
    });
    delete process.env.OPENROUTER_API_KEY;

    vi.mocked(getSupabaseServerClient).mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockResolvedValue({ data: [] }),
        eq: vi.fn().mockResolvedValue({ count: 0 }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);

    const jsx = await AdminOverviewPage();
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Not configured / Unknown");
    expect(html).not.toContain(">Healthy<");
  });
});
