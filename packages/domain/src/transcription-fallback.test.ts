import { describe, expect, it, vi } from "vitest";
import type {
  TranscriptionProvider,
  TranscriptionResult,
} from "@applywizz/transcription";
import {
  TranscriptionApiError,
  TranscriptionTimeoutError,
} from "@applywizz/transcription";
import {
  AllTranscriptionProvidersFailedError,
  executeTranscriptionWithFallback,
} from "./transcription-fallback";

function createMockResult(providerName: string, text = "Hello world"): TranscriptionResult {
  return {
    text,
    detectedLanguage: "en",
    durationSeconds: 2.5,
    model: `${providerName}-model`,
    providerMetadata: { provider: providerName },
    usage: { seconds: 2.5, cost: 0.001 },
    segments: [
      {
        index: 0,
        startMs: 0,
        endMs: 2500,
        text,
        confidence: 0.95,
        language: "en",
      },
    ],
    words: null,
  };
}

describe("executeTranscriptionWithFallback", () => {
  it("scenario 1: Azure succeeds on first attempt -> accepted, 1 attempt, no fallback invoked", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi.fn().mockResolvedValue(createMockResult("azure-mai")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn(),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("azure-mai");
    expect(res.fallbackReason).toBeNull();
    expect(res.attempts).toEqual([
      {
        sequence: 1,
        provider: "azure-mai",
        model: "azure-mai-model",
        outcome: "accepted",
      },
    ]);
    expect(primaryMock.transcribe).toHaveBeenCalledTimes(1);
    expect(fallbackMock.transcribe).not.toHaveBeenCalled();
  });

  it("scenario 2: Azure fails with TIMEOUT on attempt 1, succeeds on attempt 2 -> accepted, 2 attempts, no fallback invoked", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionTimeoutError())
        .mockResolvedValueOnce(createMockResult("azure-mai")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn(),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("azure-mai");
    expect(res.fallbackReason).toBeNull();
    expect(res.attempts).toEqual([
      {
        sequence: 1,
        provider: "azure-mai",
        model: "azure-mai",
        outcome: "failed",
        failureCode: "TIMEOUT",
      },
      {
        sequence: 2,
        provider: "azure-mai",
        model: "azure-mai-model",
        outcome: "accepted",
      },
    ]);
    expect(primaryMock.transcribe).toHaveBeenCalledTimes(2);
    expect(fallbackMock.transcribe).not.toHaveBeenCalled();
  });

  it("scenario 3: Azure fails with RATE_LIMIT (429) on attempt 1, succeeds on attempt 2", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionApiError(429, "Too many requests"))
        .mockResolvedValueOnce(createMockResult("azure-mai")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn(),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("azure-mai");
    expect(res.attempts).toHaveLength(2);
    expect(res.attempts[0]!.failureCode).toBe("RATE_LIMIT");
    expect(res.attempts[1]!.outcome).toBe("accepted");
    expect(fallbackMock.transcribe).not.toHaveBeenCalled();
  });

  it("scenario 4: Azure fails with PROVIDER_5XX (503) on attempt 1, succeeds on attempt 2", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionApiError(503, "Service Unavailable"))
        .mockResolvedValueOnce(createMockResult("azure-mai")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn(),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("azure-mai");
    expect(res.attempts[0]!.failureCode).toBe("PROVIDER_5XX");
    expect(res.attempts[1]!.outcome).toBe("accepted");
  });

  it("scenario 5: Azure fails with TIMEOUT twice -> falls back to OpenRouter -> OpenRouter succeeds", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionTimeoutError())
        .mockRejectedValueOnce(new TranscriptionTimeoutError()),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn().mockResolvedValue(createMockResult("openrouter")),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("openrouter");
    expect(res.fallbackReason).toContain("Primary provider azure-mai failed after 2 attempts. Final error: TIMEOUT");
    expect(res.attempts).toEqual([
      {
        sequence: 1,
        provider: "azure-mai",
        model: "azure-mai",
        outcome: "failed",
        failureCode: "TIMEOUT",
      },
      {
        sequence: 2,
        provider: "azure-mai",
        model: "azure-mai",
        outcome: "failed",
        failureCode: "TIMEOUT",
      },
      {
        sequence: 3,
        provider: "openrouter",
        model: "openrouter-model",
        outcome: "accepted",
      },
    ]);
    expect(primaryMock.transcribe).toHaveBeenCalledTimes(2);
    expect(fallbackMock.transcribe).toHaveBeenCalledTimes(1);
  });

  it("scenario 6: Azure fails with AUTH_FAILURE (401) -> skips retry -> immediately invokes fallback", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionApiError(401, "Unauthorized / invalid key")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn().mockResolvedValue(createMockResult("openrouter")),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("openrouter");
    expect(res.fallbackReason).toContain("Primary provider azure-mai encountered non-retryable error: AUTH_FAILURE");
    expect(res.attempts).toEqual([
      {
        sequence: 1,
        provider: "azure-mai",
        model: "azure-mai",
        outcome: "failed",
        failureCode: "AUTH_FAILURE",
      },
      {
        sequence: 2,
        provider: "openrouter",
        model: "openrouter-model",
        outcome: "accepted",
      },
    ]);
    // Critical assertion: primary was NEVER retried on 401
    expect(primaryMock.transcribe).toHaveBeenCalledTimes(1);
    expect(fallbackMock.transcribe).toHaveBeenCalledTimes(1);
  });

  it("scenario 7: Azure returns empty transcript -> rejected -> falls back to OpenRouter", async () => {
    const emptyResult: TranscriptionResult = {
      text: "   ",
      detectedLanguage: "en",
      durationSeconds: 1.0,
      model: "azure-mai-model",
      providerMetadata: {},
      usage: { seconds: 1.0, cost: 0 },
      segments: [],
      words: null,
    };

    const primaryMock = {
      name: "azure-mai",
      transcribe: vi.fn().mockResolvedValue(emptyResult),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn().mockResolvedValue(createMockResult("openrouter")),
    } satisfies TranscriptionProvider;

    const res = await executeTranscriptionWithFallback({
      primaryProvider: primaryMock,
      fallbackProvider: fallbackMock,
      filePath: "/dummy/path.wav",
    });

    expect(res.acceptedProvider.name).toBe("openrouter");
    expect(res.attempts[0]!.failureCode).toBe("EMPTY_TRANSCRIPT");
    expect(res.attempts[1]!.outcome).toBe("accepted");
    expect(primaryMock.transcribe).toHaveBeenCalledTimes(1);
    expect(fallbackMock.transcribe).toHaveBeenCalledTimes(1);
  });

  it("scenario 8: Both primary and fallback fail -> throws AllTranscriptionProvidersFailedError", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionTimeoutError()),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionApiError(500, "Internal OpenRouter error")),
    } satisfies TranscriptionProvider;

    await expect(
      executeTranscriptionWithFallback({
        primaryProvider: primaryMock,
        fallbackProvider: fallbackMock,
        filePath: "/dummy/path.wav",
      }),
    ).rejects.toThrow(AllTranscriptionProvidersFailedError);

    try {
      await executeTranscriptionWithFallback({
        primaryProvider: primaryMock,
        fallbackProvider: fallbackMock,
        filePath: "/dummy/path.wav",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AllTranscriptionProvidersFailedError);
      const allErr = err as AllTranscriptionProvidersFailedError;
      expect(allErr.attempts).toHaveLength(3);
      expect(allErr.attempts[0]!.provider).toBe("azure-mai");
      expect(allErr.attempts[1]!.provider).toBe("azure-mai");
      expect(allErr.attempts[2]!.provider).toBe("openrouter");
      expect(allErr.attempts[2]!.failureCode).toBe("PROVIDER_5XX");
    }
  });

  it("scenario 9: Primary fails and no fallback configured -> throws AllTranscriptionProvidersFailedError", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionTimeoutError()),
    } satisfies TranscriptionProvider;

    await expect(
      executeTranscriptionWithFallback({
        primaryProvider: primaryMock,
        filePath: "/dummy/path.wav",
      }),
    ).rejects.toThrow(AllTranscriptionProvidersFailedError);
  });

  it("scenario 10: Fallback returns empty transcript -> fails closed", async () => {
    const primaryMock = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionApiError(401, "Unauthorized")),
    } satisfies TranscriptionProvider;

    const fallbackMock = {
      name: "openrouter",
      transcribe: vi.fn().mockResolvedValue({
        text: "",
        detectedLanguage: null,
        durationSeconds: 1.0,
        model: "whisper",
        providerMetadata: {},
        usage: { seconds: 1.0, cost: 0 },
        segments: [],
        words: null,
      }),
    } satisfies TranscriptionProvider;

    await expect(
      executeTranscriptionWithFallback({
        primaryProvider: primaryMock,
        fallbackProvider: fallbackMock,
        filePath: "/dummy/path.wav",
      }),
    ).rejects.toThrow(AllTranscriptionProvidersFailedError);
  });
});
