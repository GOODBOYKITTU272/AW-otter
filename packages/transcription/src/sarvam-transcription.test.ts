import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TranscriptionApiError,
  TranscriptionAuthError,
  TranscriptionEmptyTranscriptError,
  TranscriptionMalformedResponseError,
  TranscriptionRateLimitError,
  TranscriptionTimeoutError,
} from "./errors";
import {
  mapLanguageToSarvamCode,
  normalizeSarvamBatchResult,
  SarvamTranscriptionProvider,
  type RawSarvamBatchResult,
} from "./sarvam-transcription";

async function withTempFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `sarvam-test-${crypto.randomUUID()}.wav`);
  await writeFile(path, new Uint8Array([1, 2, 3, 4]));
  try {
    return await fn(path);
  } finally {
    await rm(path, { force: true });
  }
}

describe("normalizeSarvamBatchResult", () => {
  it("normalizes diarized entries with chunk timestamps and null words", () => {
    const raw: RawSarvamBatchResult = {
      request_id: "req-1",
      transcript: "Hello. నమస్కారం.",
      language_code: "te-IN",
      diarized_transcript: {
        entries: [
          {
            transcript: "Hello.",
            start_time_seconds: 0.1,
            end_time_seconds: 1.2,
            speaker_id: 0,
          },
          {
            transcript: "నమస్కారం.",
            start_time_seconds: 1.5,
            end_time_seconds: 2.8,
            speaker_id: 1,
          },
        ],
      },
    };

    const result = normalizeSarvamBatchResult(raw, "saaras:v4");
    expect(result.text).toBe("Hello. నమస్కారం.");
    expect(result.detectedLanguage).toBe("te-IN");
    expect(result.words).toBeNull();
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.speakerTag).toBe("Speaker 0");
    expect(result.segments[0]!.startMs).toBe(100);
    expect(result.segments[0]!.endMs).toBe(1200);
    expect(result.segments[0]!.words).toBeNull();
    expect(result.segments[1]!.speakerTag).toBe("Speaker 1");
    expect(result.providerMetadata.apiMode).toBe("batch");
    expect(result.providerMetadata.wordTimestamps).toBe(false);
    expect(result.providerMetadata.speakers).toEqual([0, 1]);
  });

  it("treats timestamps.words as chunk-level (not word-level)", () => {
    const raw: RawSarvamBatchResult = {
      transcript: "One. Two.",
      language_code: "hi-IN",
      timestamps: {
        words: ["One.", "Two."],
        start_time_seconds: [0, 0.6],
        end_time_seconds: [0.5, 1.1],
      },
    };
    const result = normalizeSarvamBatchResult(raw, "saaras:v4");
    expect(result.segments).toHaveLength(2);
    expect(result.words).toBeNull();
    expect(result.segments[0]!.words).toBeNull();
  });

  it("falls back to chunk timestamps when diarization is absent", () => {
    const raw: RawSarvamBatchResult = {
      transcript: "One two",
      language_code: "hi-IN",
      timestamps: {
        chunks: ["One", "two"],
        start_time_seconds: [0, 0.5],
        end_time_seconds: [0.4, 0.9],
      },
    };
    const result = normalizeSarvamBatchResult(raw, "saaras:v4");
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]!.text).toBe("One");
    expect(result.segments[1]!.startMs).toBe(500);
    expect(result.words).toBeNull();
  });

  it("throws on empty transcript", () => {
    expect(() =>
      normalizeSarvamBatchResult({ transcript: "   " }, "saaras:v4"),
    ).toThrow(TranscriptionEmptyTranscriptError);
  });

  it("throws on malformed root", () => {
    expect(() =>
      normalizeSarvamBatchResult(null as unknown as RawSarvamBatchResult, "saaras:v4"),
    ).toThrow(TranscriptionMalformedResponseError);
  });
});

describe("mapLanguageToSarvamCode", () => {
  it("maps common language shortcuts", () => {
    expect(mapLanguageToSarvamCode("te")).toBe("te-IN");
    expect(mapLanguageToSarvamCode("hi-IN")).toBe("hi-IN");
    expect(mapLanguageToSarvamCode("unknown")).toBe("unknown");
  });
});

describe("SarvamTranscriptionProvider Client", () => {
  function mockBatchFetch(opts: {
    initiateStatus?: number;
    uploadLinksStatus?: number;
    putStatus?: number;
    startStatus?: number;
    statusSequence?: Array<{ status: number; body: unknown }>;
    downloadLinksStatus?: number;
    resultStatus?: number;
    resultBody?: unknown;
  } = {}) {
    const jobId = "job-abc";
    let statusCalls = 0;
    const statusSequence = opts.statusSequence ?? [
      { status: 200, body: { job_state: "Completed", job_details: [{ outputs: [{ file_name: "0.json" }] }] } },
    ];

    return vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/speech-to-text/job/v1") && method === "POST") {
        const status = opts.initiateStatus ?? 202;
        if (status !== 202 && status !== 200) {
          return new Response("fail", { status });
        }
        return new Response(JSON.stringify({ job_id: jobId }), { status });
      }
      if (url.endsWith("/speech-to-text/job/v1/upload-files")) {
        const status = opts.uploadLinksStatus ?? 200;
        if (status !== 200) return new Response("fail", { status });
        let uploadName = "audio.wav";
        try {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { files?: string[] };
          uploadName = parsed.files?.[0] ?? uploadName;
        } catch {
          /* keep default */
        }
        return new Response(
          JSON.stringify({
            upload_urls: {
              [uploadName]: { file_url: "https://blob.example/upload" },
            },
          }),
          { status },
        );
      }
      if (url === "https://blob.example/upload") {
        return new Response(null, { status: opts.putStatus ?? 201 });
      }
      if (url.includes(`/speech-to-text/job/v1/${jobId}/start`)) {
        const status = opts.startStatus ?? 200;
        return new Response(status >= 400 ? "fail" : "{}", { status });
      }
      if (url.includes(`/speech-to-text/job/v1/${jobId}/status`)) {
        const step = statusSequence[Math.min(statusCalls, statusSequence.length - 1)]!;
        statusCalls += 1;
        return new Response(JSON.stringify(step.body), { status: step.status });
      }
      if (url.endsWith("/speech-to-text/job/v1/download-files")) {
        const status = opts.downloadLinksStatus ?? 200;
        if (status !== 200) return new Response("fail", { status });
        return new Response(
          JSON.stringify({
            download_urls: {
              "0.json": { file_url: "https://blob.example/result.json" },
            },
          }),
          { status },
        );
      }
      if (url === "https://blob.example/result.json") {
        const status = opts.resultStatus ?? 200;
        const body =
          opts.resultBody ??
          ({
            request_id: "r1",
            transcript: "नमस्ते",
            language_code: "hi-IN",
            diarized_transcript: {
              entries: [
                {
                  transcript: "नमस्ते",
                  start_time_seconds: 0,
                  end_time_seconds: 1.1,
                  speaker_id: 0,
                },
              ],
            },
          } satisfies RawSarvamBatchResult);
        return new Response(JSON.stringify(body), { status });
      }
      return new Response(`unexpected ${method} ${url}`, { status: 500 });
    });
  }

  it("runs the batch lifecycle and returns normalized result", async () => {
    const fetchImpl = mockBatchFetch();
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );

    await withTempFile(async (path) => {
      const res = await provider.transcribe(path);
      expect(res.text).toBe("नमस्ते");
      expect(res.model).toBe("saaras:v4");
      expect(res.providerMetadata.apiMode).toBe("batch");
      expect(res.words).toBeNull();
      expect(fetchImpl).toHaveBeenCalled();
      const initiateCall = fetchImpl.mock.calls.find((c) =>
        String(c[0]).endsWith("/speech-to-text/job/v1"),
      );
      expect(initiateCall).toBeTruthy();
      const headers = initiateCall![1]!.headers as Record<string, string>;
      expect(headers["api-subscription-key"]).toBe("test-key");
      const body = JSON.parse(String(initiateCall![1]!.body));
      expect(body.job_parameters.model).toBe("saaras:v4");
      expect(body.job_parameters.language_code).toBe("unknown");
      expect(body.job_parameters.with_diarization).toBe(true);
    });
  });

  it("throws TranscriptionAuthError on 401 initiate", async () => {
    const fetchImpl = mockBatchFetch({ initiateStatus: 401 });
    const provider = new SarvamTranscriptionProvider(
      "bad-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionAuthError);
    });
  });

  it("throws TranscriptionRateLimitError on 429", async () => {
    const fetchImpl = mockBatchFetch({ initiateStatus: 429 });
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionRateLimitError);
    });
  });

  it("throws TranscriptionApiError on 500", async () => {
    const fetchImpl = mockBatchFetch({ initiateStatus: 500 });
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionApiError);
    });
  });

  it("throws TranscriptionTimeoutError when job never completes", async () => {
    const fetchImpl = mockBatchFetch({
      statusSequence: [
        { status: 200, body: { job_state: "Pending" } },
        { status: 200, body: { job_state: "Running" } },
      ],
    });
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      50, // tiny timeout
      10,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(TranscriptionTimeoutError);
    });
  });

  it("throws TranscriptionMalformedResponseError when initiate omits job_id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 202 }));
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(
        TranscriptionMalformedResponseError,
      );
    });
  });

  it("throws TranscriptionEmptyTranscriptError when result text is empty", async () => {
    const fetchImpl = mockBatchFetch({
      resultBody: { transcript: "", diarized_transcript: { entries: [] } },
    });
    const provider = new SarvamTranscriptionProvider(
      "test-key",
      "saaras:v4",
      "transcribe",
      10_000,
      1,
      fetchImpl as unknown as typeof fetch,
    );
    await withTempFile(async (path) => {
      await expect(provider.transcribe(path)).rejects.toThrow(
        TranscriptionEmptyTranscriptError,
      );
    });
  });
});
