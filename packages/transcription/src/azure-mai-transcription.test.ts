import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AzureMaiTranscriptionProvider,
  normalizeAzureMaiResponse,
  type RawAzureMaiResponse,
} from "./azure-mai-transcription";
import {
  TranscriptionApiError,
  TranscriptionAuthError,
  TranscriptionMalformedResponseError,
  TranscriptionRateLimitError,
  TranscriptionTimeoutError,
} from "./errors";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `azure-test-${crypto.randomUUID()}.wav`);
  await writeFile(path, new Uint8Array([1, 2, 3]));
  try {
    return await fn(path);
  } finally {
    await rm(path, { force: true });
  }
}

describe("AzureMaiTranscriptionProvider Normalization", () => {
  it("correctly normalizes phrases, preserves Speaker 0 and Speaker 1, and maps word timestamps", () => {
    const raw: RawAzureMaiResponse = {
      durationMilliseconds: 18000,
      combinedPhrases: [{ text: "Hello world. How are you?" }],
      phrases: [
        {
          speaker: 0,
          offsetMilliseconds: 100,
          durationMilliseconds: 2500,
          text: "Hello world.",
          locale: "en",
          confidence: 0.95,
          words: [
            { text: "Hello", offsetMilliseconds: 100, durationMilliseconds: 1000 },
            { text: "world.", offsetMilliseconds: 1200, durationMilliseconds: 1400 },
          ],
        },
        {
          speaker: 1,
          offsetMilliseconds: 2800,
          durationMilliseconds: 3200,
          text: "బాగున్నాను, ధన్యవాదాలు.",
          locale: "te",
          confidence: 0.92,
          words: [
            { text: "బాగున్నాను,", offsetMilliseconds: 2800, durationMilliseconds: 1500 },
            { text: "ధన్యవాదాలు.", offsetMilliseconds: 4400, durationMilliseconds: 1600 },
          ],
        },
      ],
    };

    const result = normalizeAzureMaiResponse(raw, "MAI-Transcribe-2");

    expect(result.text).toBe("Hello world. How are you?");
    expect(result.detectedLanguage).toBe("en");
    expect(result.durationSeconds).toBe(18);
    expect(result.model).toBe("MAI-Transcribe-2");
    expect(result.segments).toHaveLength(2);

    // Speaker 0 segment
    const seg0 = result.segments[0]!;
    expect(seg0.index).toBe(0);
    expect(seg0.startMs).toBe(100);
    expect(seg0.endMs).toBe(2600);
    expect(seg0.speakerTag).toBe("Speaker 0");
    expect(seg0.speakerNumericId).toBe(0);
    expect(seg0.confidence).toBe(0.95);
    expect(seg0.words).toHaveLength(2);
    expect(seg0.words?.[0]).toEqual({ word: "Hello", startMs: 100, endMs: 1100 });

    // Speaker 1 segment
    const seg1 = result.segments[1]!;
    expect(seg1.index).toBe(1);
    expect(seg1.startMs).toBe(2800);
    expect(seg1.endMs).toBe(6000);
    expect(seg1.speakerTag).toBe("Speaker 1");
    expect(seg1.speakerNumericId).toBe(1);
    expect(seg1.confidence).toBe(0.92);

    // Global word list
    expect(result.words).toHaveLength(4);
    expect(result.words?.[2]).toEqual({
      word: "బాగున్నాను,",
      startMs: 2800,
      endMs: 4300,
    });

    // Metadata
    expect(result.providerMetadata.speakerCount).toBe(2);
    expect(result.providerMetadata.speakers).toEqual([0, 1]);
  });

  it("safely handles missing, null, or string speaker attributes", () => {
    const raw: RawAzureMaiResponse = {
      durationMilliseconds: 10000,
      phrases: [
        {
          speaker: null,
          offsetMilliseconds: 0,
          durationMilliseconds: 2000,
          text: "Unattributed turn.",
        },
        {
          speaker: "1",
          offsetMilliseconds: 2500,
          durationMilliseconds: 3000,
          text: "Speaker from string ID.",
        },
      ],
    };

    const result = normalizeAzureMaiResponse(raw, "MAI-Transcribe-2");
    expect(result.segments[0]!.speakerTag).toBe("speaker_unknown");
    expect(result.segments[0]!.speakerNumericId).toBeNull();
    expect(result.segments[1]!.speakerTag).toBe("Speaker 1");
    expect(result.segments[1]!.speakerNumericId).toBe(1);
    expect(result.providerMetadata.speakerCount).toBe(1);
    expect(result.providerMetadata.speakers).toEqual([1]);
  });

  it("throws TranscriptionMalformedResponseError on invalid response structure", () => {
    expect(() => normalizeAzureMaiResponse({} as RawAzureMaiResponse, "MAI-Transcribe-2")).toThrow(
      TranscriptionMalformedResponseError,
    );
  });

  it("preserves per-segment locale across mixed-language phrases", () => {
    const raw: RawAzureMaiResponse = {
      durationMilliseconds: 10000,
      phrases: [
        {
          speaker: 0,
          offsetMilliseconds: 0,
          durationMilliseconds: 2000,
          text: "How was your interview?",
          locale: "en",
        },
        {
          speaker: 1,
          offsetMilliseconds: 2200,
          durationMilliseconds: 3000,
          text: "నేను బాగా చేశాను.",
          locale: "te",
        },
        {
          speaker: 0,
          offsetMilliseconds: 5400,
          durationMilliseconds: 2000,
          text: "That sounds great!",
          locale: "en",
        },
      ],
    };

    const result = normalizeAzureMaiResponse(raw, "MAI-Transcribe-2");
    expect(result.segments).toHaveLength(3);
    expect(result.segments[0]!.language).toBe("en");
    expect(result.segments[1]!.language).toBe("te");
    expect(result.segments[2]!.language).toBe("en");
  });
});

describe("AzureMaiTranscriptionProvider Client", () => {
  it("sends enhancedMode and diarization definition and parses valid response", async () => {
    const mockRaw: RawAzureMaiResponse = {
      durationMilliseconds: 5000,
      combinedPhrases: [{ text: "Test phrase" }],
      phrases: [
        {
          speaker: 0,
          offsetMilliseconds: 0,
          durationMilliseconds: 5000,
          text: "Test phrase",
          locale: "en",
        },
      ],
    };

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toContain("/speechtotext/transcriptions:transcribe?api-version=2025-10-15");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("test-key");
      const form = init.body as FormData;
      const def = JSON.parse(form.get("definition") as string);
      expect(def.enhancedMode.enabled).toBe(true);
      expect(def.enhancedMode.model).toBe("MAI-Transcribe-2");
      expect(def.diarization.enabled).toBe(true);
      return new Response(JSON.stringify(mockRaw), { status: 200 });
    });

    const provider = new AzureMaiTranscriptionProvider(
      "https://example.cognitiveservices.azure.com",
      "test-key",
      "eastus",
      "MAI-Transcribe-2",
      "2025-10-15",
      10000,
      fetchImpl as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      const res = await provider.transcribe(path);
      expect(res.text).toBe("Test phrase");
      expect(res.segments[0]!.speakerTag).toBe("Speaker 0");
    });
  });

  it("throws TranscriptionAuthError on 401 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    const provider = new AzureMaiTranscriptionProvider(
      "https://example.cognitiveservices.azure.com",
      "test-key",
      "eastus",
      "MAI-Transcribe-2",
      "2025-10-15",
      10000,
      mockFetch as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionAuthError);
    });
  });

  it("throws TranscriptionRateLimitError on 429 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Rate limit", { status: 429 }),
    );
    const provider = new AzureMaiTranscriptionProvider(
      "https://example.cognitiveservices.azure.com",
      "test-key",
      "eastus",
      "MAI-Transcribe-2",
      "2025-10-15",
      10000,
      mockFetch as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionRateLimitError);
    });
  });

  it("throws TranscriptionApiError on 500 server error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    const provider = new AzureMaiTranscriptionProvider(
      "https://example.cognitiveservices.azure.com",
      "test-key",
      "eastus",
      "MAI-Transcribe-2",
      "2025-10-15",
      10000,
      mockFetch as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionApiError);
    });
  });

  it("throws TranscriptionTimeoutError when request aborts", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));
    const provider = new AzureMaiTranscriptionProvider(
      "https://example.cognitiveservices.azure.com",
      "test-key",
      "eastus",
      "MAI-Transcribe-2",
      "2025-10-15",
      100,
      mockFetch as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionTimeoutError);
    });
  });
});
