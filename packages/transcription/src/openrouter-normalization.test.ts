import { describe, expect, it, vi } from "vitest";
import { OpenRouterNormalizationProvider } from "./openrouter-normalization";
import {
  TranscriptionApiError,
  TranscriptionMalformedResponseError,
  TranscriptionTimeoutError,
} from "./errors";

describe("OpenRouterNormalizationProvider", () => {
  it("sends the source text/language and returns the model's canonical English text", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(init.body as string);
      expect(body.messages[1].content).toContain("Python side ki shift avvali");
      expect(body.messages[1].content).toContain("Source language: te");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "Shift toward Python and target more backend roles.",
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const provider = new OpenRouterNormalizationProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    const result = await provider.normalize(
      "Python side ki shift avvali, backend roles ekkuva target cheddam.",
      "te",
    );
    expect(result.canonicalEnglishText).toBe(
      "Shift toward Python and target more backend roles.",
    );
    expect(result.confidence).toBeNull();
  });

  it("throws TranscriptionApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const provider = new OpenRouterNormalizationProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.normalize("text", "te")).rejects.toBeInstanceOf(
      TranscriptionApiError,
    );
  });

  it("throws TranscriptionMalformedResponseError when no message content is present", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const provider = new OpenRouterNormalizationProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.normalize("text", "te")).rejects.toBeInstanceOf(
      TranscriptionMalformedResponseError,
    );
  });

  it("throws TranscriptionTimeoutError when the request aborts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const provider = new OpenRouterNormalizationProvider(
      "test-key",
      undefined,
      20,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.normalize("text", "te")).rejects.toBeInstanceOf(
      TranscriptionTimeoutError,
    );
  });

  it("never includes the API key in any thrown error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 401 }));
    const provider = new OpenRouterNormalizationProvider(
      "super-secret-key-value",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    try {
      await provider.normalize("text", "te");
      throw new Error("expected normalize to reject");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-key-value");
    }
  });
});
