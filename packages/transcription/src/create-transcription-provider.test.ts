import { describe, expect, it } from "vitest";
import { createTranscriptionProvider } from "./index";

describe("createTranscriptionProvider", () => {
  it("selects azure-mai when primaryProvider is azure-mai and credentials exist", () => {
    const provider = createTranscriptionProvider({
      primaryProvider: "azure-mai",
      azureMai: {
        endpoint: "https://example.cognitiveservices.azure.com",
        apiKey: "test-key",
        region: "eastus",
      },
      openRouter: { apiKey: "or-key" },
    });
    expect(provider.name).toBe("azure-mai");
  });

  it("refuses silent OpenRouter fallthrough when azure-mai is selected without credentials", () => {
    expect(() =>
      createTranscriptionProvider({
        primaryProvider: "azure-mai",
        openRouter: { apiKey: "or-key" },
      }),
    ).toThrow(/Refusing silent OpenRouter fallback/);
  });

  it("uses openrouter when primaryProvider is openrouter", () => {
    const provider = createTranscriptionProvider({
      primaryProvider: "openrouter",
      openRouter: { apiKey: "or-key" },
    });
    expect(provider.name).toBe("openrouter");
  });

  it("uses openrouter when primaryProvider is omitted and openRouter key exists", () => {
    const provider = createTranscriptionProvider({
      openRouter: { apiKey: "or-key" },
    });
    expect(provider.name).toBe("openrouter");
  });
});
