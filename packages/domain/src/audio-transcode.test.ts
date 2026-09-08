import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_TRANSCODE_INPUT_BYTES,
  TranscodeFailedError,
  TranscodeInputRejectedError,
  TranscodeTimeoutError,
  assertTranscodableInputSize,
  probeAudioFile,
  transcodeToOpusOgg,
} from "./audio-transcode";

const execFileAsync = promisify(execFile);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "audio-transcode-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Purely synthetic (ffmpeg's own silence generator) — never real recorded audio. */
async function generateSilentWebm(path: string, seconds = 1): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=48000:cl=stereo`,
    "-t",
    String(seconds),
    "-c:a",
    "libopus",
    path,
  ]);
}

describe("assertTranscodableInputSize", () => {
  it("rejects an empty input", () => {
    expect(() => assertTranscodableInputSize(0)).toThrow(
      TranscodeInputRejectedError,
    );
  });

  it("rejects an oversized input", () => {
    expect(() =>
      assertTranscodableInputSize(MAX_TRANSCODE_INPUT_BYTES + 1),
    ).toThrow(TranscodeInputRejectedError);
  });

  it("accepts a reasonable size", () => {
    expect(() => assertTranscodableInputSize(1024)).not.toThrow();
  });
});

describe("transcodeToOpusOgg", () => {
  it("transcodes a valid audio file into a clean, probeable Opus/Ogg output", async () => {
    const input = join(dir, "input.webm");
    const output = join(dir, "output.ogg");
    await generateSilentWebm(input, 2);

    await transcodeToOpusOgg(input, output);

    const probe = await probeAudioFile(output);
    expect(probe.hasAudioStream).toBe(true);
    expect(probe.durationSeconds).toBeGreaterThan(1);
  });

  it("throws TranscodeFailedError for a non-existent input file", async () => {
    await expect(
      transcodeToOpusOgg(
        join(dir, "does-not-exist.webm"),
        join(dir, "out.ogg"),
      ),
    ).rejects.toBeInstanceOf(TranscodeFailedError);
  });

  it("throws TranscodeFailedError for garbage (non-audio) input", async () => {
    const input = join(dir, "garbage.webm");
    await writeFile(input, "not audio data");
    await expect(
      transcodeToOpusOgg(input, join(dir, "out.ogg")),
    ).rejects.toBeInstanceOf(TranscodeFailedError);
  });

  it("throws TranscodeTimeoutError when the timeout is exceeded", async () => {
    const input = join(dir, "input.webm");
    await generateSilentWebm(input, 3);
    // 1ms is exceeded before ffmpeg can possibly finish — deterministic.
    await expect(
      transcodeToOpusOgg(input, join(dir, "out.ogg"), 1),
    ).rejects.toBeInstanceOf(TranscodeTimeoutError);
  });
});

describe("probeAudioFile", () => {
  it("returns hasAudioStream: false and null duration for a non-existent file", async () => {
    const probe = await probeAudioFile(join(dir, "does-not-exist.ogg"));
    expect(probe).toEqual({ durationSeconds: null, hasAudioStream: false });
  });

  it("returns real duration/stream info for a valid file", async () => {
    const input = join(dir, "input.webm");
    const output = join(dir, "output.ogg");
    await generateSilentWebm(input, 2);
    await transcodeToOpusOgg(input, output);

    const probe = await probeAudioFile(output);
    expect(probe.hasAudioStream).toBe(true);
    expect(probe.durationSeconds).not.toBeNull();
  });
});
