import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OpenRouterTranscriptionProvider } from "./openrouter-transcription";
import {
  TranscriptionApiError,
  TranscriptionMalformedResponseError,
  TranscriptionTimeoutError,
} from "./errors";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `transcription-test-${crypto.randomUUID()}.ogg`);
  await writeFile(path, new Uint8Array([1, 2, 3]));
  try {
    return await fn(path);
  } finally {
    await rm(path, { force: true });
  }
}

const VERBOSE_JSON_BODY = {
  text: "We should shift toward Python.",
  language: "en",
  duration: 4.5,
  segments: [
    {
      id: 0,
      start: 0,
      end: 4.5,
      text: "We should shift toward Python.",
      avg_logprob: -0.1,
    },
  ],
  words: [
    { word: "We", start: 0, end: 0.2 },
    { word: "should", start: 0.2, end: 0.5 },
  ],
  usage: { seconds: 4.5, cost: 0.00003 },
};

describe("OpenRouterTranscriptionProvider", () => {
  it("sends the expected multipart request and normalizes a valid verbose_json response", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key",
      );
      const form = init.body as FormData;
      expect(form.get("model")).toBe("openai/whisper-large-v3-turbo");
      expect(form.get("response_format")).toBe("verbose_json");
      expect(form.getAll("timestamp_granularities[]")).toEqual([
        "segment",
        "word",
      ]);
      return new Response(JSON.stringify(VERBOSE_JSON_BODY), { status: 200 });
    });

    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      const result = await provider.transcribe(path);
      expect(result.text).toBe("We should shift toward Python.");
      expect(result.detectedLanguage).toBe("en");
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]?.startMs).toBe(0);
      expect(result.segments[0]?.endMs).toBe(4500);
      expect(result.words).toHaveLength(2);
      expect(result.usage.cost).toBe(0.00003);
      expect(result.model).toBe("openai/whisper-large-v3-turbo");
    });
  });

  it("transcribes WAV files and attaches audio/wav MIME type", async () => {
    let capturedBlobType: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      const fileBlob = form.get("file") as Blob;
      capturedBlobType = fileBlob?.type;
      return new Response(JSON.stringify(VERBOSE_JSON_BODY), { status: 200 });
    });

    const wavPath = join(tmpdir(), `transcription-wav-${crypto.randomUUID()}.wav`);
    await writeFile(wavPath, new Uint8Array([1, 2, 3]));
    try {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      const result = await provider.transcribe(wavPath);
      expect(capturedBlobType).toBe("audio/wav");
      expect(result.text).toBe("We should shift toward Python.");
    } finally {
      await rm(wavPath, { force: true });
    }
  });

  it("passes the language option through when supplied", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get("language")).toBe("te");
      return new Response(JSON.stringify(VERBOSE_JSON_BODY), { status: 200 });
    });
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      await provider.transcribe(path, { language: "te" });
    });
  });

  it("throws TranscriptionApiError on a non-2xx response, without including the response body in the error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ secret_leak: "should never appear" }), {
          status: 500,
        }),
    );
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      try {
        await provider.transcribe(path);
        throw new Error("expected transcribe to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(TranscriptionApiError);
        expect((error as Error).message).not.toContain("secret_leak");
      }
    });
  });

  it("drops segments/words with missing, negative, or reversed timestamps instead of persisting them", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            text: "ok",
            language: "en",
            duration: 4.5,
            segments: [
              { id: 0, start: 0, end: 1, text: "good segment" },
              { id: 1, start: -1, end: 2, text: "negative start" },
              { id: 2, start: 3, end: 2, text: "reversed" },
              { id: 3, end: 2, text: "missing start" },
            ],
            words: [
              { word: "ok", start: 0, end: 0.5 },
              { word: "bad", start: -1, end: 0.5 },
            ],
            usage: { seconds: 4.5, cost: 0.00003 },
          }),
          { status: 200 },
        ),
    );
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      const result = await provider.transcribe(path);
      expect(result.segments).toHaveLength(1);
      expect(result.segments[0]?.text).toBe("good segment");
      expect(result.words).toHaveLength(1);
      expect(result.words?.[0]?.word).toBe("ok");
    });
  });

  it("throws TranscriptionMalformedResponseError when text/segments are missing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      await expect(provider.transcribe(path)).rejects.toBeInstanceOf(
        TranscriptionMalformedResponseError,
      );
    });
  });

  it("throws TranscriptionTimeoutError when the request aborts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "test-key",
        undefined,
        20,
        fetchImpl as unknown as typeof fetch,
      );
      await expect(provider.transcribe(path)).rejects.toBeInstanceOf(
        TranscriptionTimeoutError,
      );
    });
  });

  it("never includes the API key in any thrown error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 401 }));
    await withTempFile(async (path) => {
      const provider = new OpenRouterTranscriptionProvider(
        "super-secret-key-value",
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      try {
        await provider.transcribe(path);
        throw new Error("expected transcribe to reject");
      } catch (error) {
        expect((error as Error).message).not.toContain(
          "super-secret-key-value",
        );
      }
    });
  });
});
