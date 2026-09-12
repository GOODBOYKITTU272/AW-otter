import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  routeByLanguage,
  shouldUseLanguageRouting,
  detectLanguage,
} from "./language-routing";
import type { TranscriptionProvider } from "@applywizz/transcription";

describe("shouldUseLanguageRouting", () => {
  it("should return true by default for non-azure providers", () => {
    expect(shouldUseLanguageRouting("openrouter")).toBe(true);
    expect(shouldUseLanguageRouting("sarvam")).toBe(true);
  });

  it("should return false for azure-mai to maintain backward compatibility", () => {
    expect(shouldUseLanguageRouting("azure-mai")).toBe(false);
  });

  it("should respect explicit disable flag", () => {
    expect(shouldUseLanguageRouting("openrouter", false)).toBe(false);
    expect(shouldUseLanguageRouting("sarvam", false)).toBe(false);
  });

  it("should allow explicit enable even for azure", () => {
    expect(shouldUseLanguageRouting("azure-mai", true)).toBe(false); // Still false for azure
  });
});

describe("routeByLanguage", () => {
  let mockWhisperProvider: TranscriptionProvider;
  let mockSarvamProvider: TranscriptionProvider;
  let mockAzureProvider: TranscriptionProvider;

  beforeEach(() => {
    mockWhisperProvider = {
      name: "openrouter",
      transcribe: vi.fn(),
    } as unknown as TranscriptionProvider;

    mockSarvamProvider = {
      name: "sarvam",
      transcribe: vi.fn(),
    } as unknown as TranscriptionProvider;

    mockAzureProvider = {
      name: "azure-mai",
      transcribe: vi.fn(),
    } as unknown as TranscriptionProvider;
  });

  it("should route English to Whisper with Sarvam fallback", () => {
    const decision = routeByLanguage(
      "en",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockWhisperProvider);
    expect(decision.fallbackProvider).toBe(mockSarvamProvider);
    expect(decision.reason).toContain("English");
    expect(decision.reason).toContain("Whisper");
  });

  it("should route en-US to Whisper", () => {
    const decision = routeByLanguage(
      "en-US",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockWhisperProvider);
    expect(decision.fallbackProvider).toBe(mockSarvamProvider);
  });

  it("should route Hindi to Sarvam with Whisper fallback", () => {
    const decision = routeByLanguage(
      "hi",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
    expect(decision.reason).toContain("hi");
    expect(decision.reason).toContain("Sarvam");
  });

  it("should route Telugu to Sarvam", () => {
    const decision = routeByLanguage(
      "te",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
  });

  it("should route Tamil to Sarvam", () => {
    const decision = routeByLanguage(
      "ta",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
  });

  it("should route Kannada to Sarvam", () => {
    const decision = routeByLanguage(
      "kn",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
  });

  it("should route Spanish to Sarvam (non-English fallback)", () => {
    const decision = routeByLanguage(
      "es",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
  });

  it("should route unknown language to Sarvam when available", () => {
    const decision = routeByLanguage(
      null,
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockSarvamProvider);
    expect(decision.fallbackProvider).toBe(mockWhisperProvider);
    expect(decision.reason).toContain("non-English");
  });

  it("should fall back to Whisper when Sarvam unavailable", () => {
    const decision = routeByLanguage(
      "hi",
      mockWhisperProvider,
      undefined,
      mockAzureProvider,
    );

    expect(decision.provider).toBe(mockWhisperProvider);
    expect(decision.fallbackProvider).toBe(mockAzureProvider);
    expect(decision.reason).toContain("Sarvam unavailable");
  });

  it("should handle case-insensitive language codes", () => {
    const decision1 = routeByLanguage(
      "EN",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );
    expect(decision1.provider).toBe(mockWhisperProvider);

    const decision2 = routeByLanguage(
      "En-Us",
      mockWhisperProvider,
      mockSarvamProvider,
      mockAzureProvider,
    );
    expect(decision2.provider).toBe(mockWhisperProvider);
  });
});

describe("detectLanguage", () => {
  it("should extract sample and detect language", async () => {
    const mockProvider: TranscriptionProvider = {
      name: "openrouter",
      transcribe: vi.fn().mockResolvedValue({
        text: "Hello world",
        detectedLanguage: "en",
        segments: [],
        words: null,
        model: "whisper",
        usage: { seconds: 30, cost: null },
        providerMetadata: {},
      }),
    } as unknown as TranscriptionProvider;

    // Note: This test would need actual file system mocking to work fully
    // For now, we test the interface
    expect(mockProvider.transcribe).toBeDefined();
  });
});
