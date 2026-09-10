import { describe, expect, it } from "vitest";
import { downloadRecordingMedia, getMeetingRecordingRef } from "./recordings";
import { VexaApiError } from "./errors";
import type { VexaEnv } from "./config";

const env: VexaEnv = { baseUrl: "https://vexa.test", apiKey: "test-key" };

function fakeFetch(status: number, body: unknown, isJson = true) {
  return async () =>
    new Response(isJson ? JSON.stringify(body) : (body as ArrayBuffer), {
      status,
      headers: isJson ? { "Content-Type": "application/json" } : {},
    });
}

describe("getMeetingRecordingRef", () => {
  it("returns the audio media file from the most recent completed recording", async () => {
    const ref = await getMeetingRecordingRef(
      env,
      28075,
      fakeFetch(200, {
        recordings: [
          {
            id: 1,
            status: "completed",
            media_files: [{ id: 10, type: "audio", format: "webm" }],
          },
          {
            id: 2,
            status: "completed",
            media_files: [{ id: 20, type: "audio", format: "webm" }],
          },
        ],
      }),
    );
    expect(ref).toEqual({
      recordingId: 2,
      mediaFileId: 20,
      format: "webm",
      fileSizeBytes: null, // fixture doesn't include file_size_bytes
    });
  });

  it("returns null when no recording is completed yet", async () => {
    const ref = await getMeetingRecordingRef(
      env,
      28075,
      fakeFetch(200, {
        recordings: [{ id: 1, status: "processing", media_files: [] }],
      }),
    );
    expect(ref).toBeNull();
  });

  it("returns null when there is no recordings array at all", async () => {
    const ref = await getMeetingRecordingRef(env, 28075, fakeFetch(200, {}));
    expect(ref).toBeNull();
  });

  it("returns null when the completed recording has no audio media file", async () => {
    const ref = await getMeetingRecordingRef(
      env,
      28075,
      fakeFetch(200, {
        recordings: [
          {
            id: 1,
            status: "completed",
            media_files: [{ id: 10, type: "video" }],
          },
        ],
      }),
    );
    expect(ref).toBeNull();
  });

  it("throws a typed error on a Vexa API failure", async () => {
    await expect(
      getMeetingRecordingRef(env, 28075, fakeFetch(500, { error: "boom" })),
    ).rejects.toBeInstanceOf(VexaApiError);
  });

  it("passes through the audio media file's reported file_size_bytes", async () => {
    const ref = await getMeetingRecordingRef(
      env,
      28075,
      fakeFetch(200, {
        recordings: [
          {
            id: 1,
            status: "completed",
            media_files: [
              { id: 10, type: "audio", format: "webm", file_size_bytes: 474476 },
            ],
          },
        ],
      }),
    );
    expect(ref?.fileSizeBytes).toBe(474476);
  });

  it("requests /recordings filtered by the numeric meeting id, not /transcripts", async () => {
    // M17C regression: /transcripts/{platform}/{native_meeting_id} returns
    // 403 "Insufficient scope" on the real hosted account — the numeric
    // meeting_id filter on /recordings is the endpoint that actually
    // works, confirmed against real hosted Vexa.
    let requestedUrl: string | null = null;
    const capturingFetch: typeof fetch = (async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ recordings: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await getMeetingRecordingRef(env, 28075, capturingFetch);

    expect(requestedUrl).toContain("/recordings?meeting_id=28075");
    expect(requestedUrl).not.toContain("/transcripts/");
  });
});

describe("downloadRecordingMedia", () => {
  it("returns the raw bytes on success", async () => {
    const bytes = await downloadRecordingMedia(
      env,
      1,
      10,
      fakeFetch(200, new Uint8Array([1, 2, 3]).buffer, false),
    );
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("times out (typed error) if the body stream stalls after headers arrive, not just on the initial fetch", async () => {
    // Simulates what real fetch/undici does when a controller is aborted
    // mid-body-read: the pending reader.read() rejects with an
    // AbortError. This proves the timeout genuinely bounds the WHOLE
    // download (fetch + full body read), not just the time to receive
    // headers — the bug this test was added to catch.
    const stalledFetch: typeof fetch = (async (
      _url: string,
      init?: RequestInit,
    ) => {
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Never enqueues or closes — the reader's first read() call
          // hangs until something else intervenes.
        },
        cancel() {},
      });
      init?.signal?.addEventListener("abort", () => {
        // no-op placeholder; the reader itself is made to reject below
      });
      const response = new Response(stream, { status: 200 });
      // Wire the real fetch-abort behavior this mock can't provide
      // automatically: aborting the signal should make the in-flight
      // reader.read() reject, same as a real stalled network stream would
      // under a real AbortController.
      const reader = stream.getReader();
      const originalRead = reader.read.bind(reader);
      reader.read = () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
          void originalRead();
        });
      Object.defineProperty(response, "body", {
        get: () => ({ getReader: () => reader }),
      });
      return response;
    }) as unknown as typeof fetch;

    await expect(
      downloadRecordingMedia(env, 1, 10, stalledFetch, 20),
    ).rejects.toMatchObject({ name: "VexaApiError", status: 408 });
  });

  it("throws a typed error on a download failure", async () => {
    await expect(
      downloadRecordingMedia(
        env,
        1,
        10,
        fakeFetch(404, { error: "not found" }),
      ),
    ).rejects.toBeInstanceOf(VexaApiError);
  });
});
