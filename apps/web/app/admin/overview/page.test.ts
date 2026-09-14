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
  getSarvamEnv: vi.fn(),
}));

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getAzureMaiEnv, getSarvamEnv } from "@/env/server";
import AdminOverviewPage from "./page";

describe("AdminOverviewPage honest health status", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    vi.mocked(getSarvamEnv).mockReturnValue({
      isConfigured: false,
      SARVAM_API_KEY: undefined,
    });
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
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
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
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);

    const jsx = await AdminOverviewPage();
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Not configured / Unknown");
    expect(html).not.toContain(">Healthy<");
  });

  it("source code never invents STT $/hr rates or unverified Operational badges", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./page.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("0.36");
    expect(source).not.toContain("16.5");
    expect(source).not.toContain("Live Usage Cost");
    expect(source).not.toContain('status: isOpenRouterConfigured ? "Operational"');
    expect(source).not.toContain("health: 99");
    expect(source).toContain("Configured (Not verified)");
    expect(source).toContain("Not metered yet");
    expect(source).toContain("https://openrouter.ai/api/v1/key");
  });

  it("shows DB hours + recorded usage_cost only; never labels estimates as live", async () => {
    vi.mocked(getAzureMaiEnv).mockReturnValue({
      isConfigured: true,
      AZURE_MAI_ENDPOINT: "https://mock.azure.com",
      AZURE_MAI_KEY: "secret",
      AZURE_MAI_REGION: "eastus",
    });
    vi.mocked(getSarvamEnv).mockReturnValue({
      isConfigured: true,
      SARVAM_API_KEY: "mock",
    });
    process.env.OPENROUTER_API_KEY = "sk-mock-key";

    vi.mocked(getSupabaseServerClient).mockResolvedValue({
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "meeting_transcripts") {
          return {
            select: vi.fn().mockResolvedValue({
              data: [
                {
                  provider: "whisper",
                  usage_seconds: 14.2 * 3600,
                  usage_cost: 0.9,
                  detected_language: "en",
                  processing_status: "completed",
                },
                {
                  provider: "sarvam",
                  usage_seconds: 1.8 * 3600,
                  usage_cost: null,
                  detected_language: "hi",
                  processing_status: "completed",
                },
                {
                  provider: "azure",
                  usage_seconds: 2.0 * 3600,
                  usage_cost: null,
                  detected_language: "en",
                  processing_status: "completed",
                },
              ],
            }),
          };
        }
        if (table === "ai_runs") {
          return {
            select: vi.fn().mockResolvedValue({
              data: [
                {
                  usage_metadata: {
                    prompt_tokens: 1_200_000,
                    completion_tokens: 650_000,
                    total_tokens: 1_850_000,
                    cost: 23.35,
                  },
                  status: "completed",
                  model: "anthropic/claude-3.5-sonnet",
                },
              ],
            }),
          };
        }
        if (table === "meetings") {
          return {
            select: vi.fn().mockResolvedValue({ count: 137 }),
          };
        }
        if (table === "meeting_bot_jobs") {
          return {
            select: vi.fn().mockResolvedValue({ count: 12 }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          gte: vi.fn().mockReturnThis(),
          lte: vi.fn().mockResolvedValue({ data: [] }),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: [] }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null }),
        };
      }),
    } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);

    const jsx = await AdminOverviewPage();
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("System Health &amp; Spend");
    expect(html).toContain("12 Bot Sessions • Free");
    expect(html).toContain("14.2 Audio Hrs (all-time DB)");
    expect(html).toContain("1.8 Indic Hrs (all-time DB)");
    expect(html).toContain("2.0 Audio Hrs (all-time DB)");
    expect(html).toContain("Recorded usage_cost (DB)");
    expect(html).toContain("Not metered yet");
    expect(html).toContain("Configured (Not verified)");
    expect(html).not.toContain("Live Usage Cost");
    expect(html).not.toContain(">Operational<");
    expect(html).toContain("1.85M");
    expect(html).toContain("$0.90");
    // Sarvam/Azure null usage_cost must NOT invent ₹29 / rate-based spend
    expect(html).not.toContain("₹29");
    expect(html).toContain("AI Token Usage &amp; Spend");
    expect(html).toContain("Monthly Budget");
  });

  it("renders honest zero-state when database has no records yet", async () => {
    vi.mocked(getAzureMaiEnv).mockReturnValue({
      isConfigured: false,
      AZURE_MAI_ENDPOINT: undefined,
      AZURE_MAI_KEY: undefined,
      AZURE_MAI_REGION: undefined,
    });
    vi.mocked(getSarvamEnv).mockReturnValue({
      isConfigured: false,
      SARVAM_API_KEY: undefined,
    });
    delete process.env.OPENROUTER_API_KEY;

    vi.mocked(getSupabaseServerClient).mockResolvedValue({
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnThis(),
        gte: vi.fn().mockReturnThis(),
        lte: vi.fn().mockResolvedValue({ data: [] }),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [] }),
        maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      }),
    } as unknown as Awaited<ReturnType<typeof getSupabaseServerClient>>);

    const jsx = await AdminOverviewPage();
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("$0.00");
    expect(html).toContain("₹0");
    expect(html).toContain("No transcript hours yet");
    expect(html).toContain("Not metered yet");
    expect(html).toContain("0.0%");
    expect(html).not.toContain("Live Usage Cost");
    expect(html).not.toContain(">Operational<");
  });
});
