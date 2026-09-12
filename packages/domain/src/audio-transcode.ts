import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
<<<<<<< HEAD
 * ffmpeg/ffprobe path resolution:
 * 1. Environment variable override (FFMPEG_PATH / FFPROBE_PATH)
 * 2. Docker worker standard path (/usr/bin/ffmpeg)
 * 3. Homebrew path for local development (/opt/homebrew/bin/ffmpeg)
 * 4. Fallback to PATH lookup ("ffmpeg")
 *
 * The Dockerfile (workers/transcription-worker/Dockerfile) ensures ffmpeg is
 * installed via apt-get, which places it at /usr/bin/ffmpeg on Debian/Ubuntu.
 * Local macOS development with Homebrew installs to /opt/homebrew/bin.
 */
import { existsSync } from "node:fs";

function resolveBinaryPath(
  envVar: string,
  binaryName: string,
  defaultPath: string,
): string {
  // 1. Check environment variable override
  const envPath = process.env[envVar];
  if (envPath) {
    return envPath;
  }

  // 2. Check Docker worker standard path
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  // 3. Check Homebrew path (macOS local development)
  const homebrewPath = `/opt/homebrew/bin/${binaryName}`;
  if (existsSync(homebrewPath)) {
    return homebrewPath;
  }

  // 4. Fallback to PATH lookup
  return binaryName;
}

const FFMPEG_PATH = resolveBinaryPath("FFMPEG_PATH", "ffmpeg", "/usr/bin/ffmpeg");
const FFPROBE_PATH = resolveBinaryPath("FFPROBE_PATH", "ffprobe", "/usr/bin/ffprobe");
=======
 * Prefers env var override, then absolute path (/usr/bin for Docker), 
 * then bare command (relies on PATH for Mac Homebrew: /opt/homebrew/bin/ffmpeg).
 * The Dockerfile (workers/transcription-worker/Dockerfile) ensures ffmpeg is
 * installed via apt-get at /usr/bin/ffmpeg on Debian/Ubuntu.
 */
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "/usr/bin/ffprobe";
>>>>>>> origin/p3-production-readiness

export class TranscodeError extends Error {}

export class TranscodeTimeoutError extends TranscodeError {
  constructor() {
    super("Audio transcode timed out.");
    this.name = "TranscodeTimeoutError";
  }
}

export class TranscodeInputRejectedError extends TranscodeError {
  constructor(message: string) {
    super(message);
    this.name = "TranscodeInputRejectedError";
  }
}

export class TranscodeFailedError extends TranscodeError {
  constructor(message: string) {
    super(message);
    this.name = "TranscodeFailedError";
  }
}

/**
 * Generous but bounded — real Vexa audio for a ~4-hour test session was
 * 3.4MB (opus is efficient); a genuinely oversized/unexpected input is
 * rejected outright rather than handed to ffmpeg unbounded (resource-
 * exhaustion guard).
 */
export const MAX_TRANSCODE_INPUT_BYTES = 200 * 1024 * 1024; // 200MB

export function assertTranscodableInputSize(byteLength: number): void {
  if (byteLength === 0) {
    throw new TranscodeInputRejectedError("Downloaded recording is empty.");
  }
  if (byteLength > MAX_TRANSCODE_INPUT_BYTES) {
    throw new TranscodeInputRejectedError(
      `Downloaded recording (${byteLength} bytes) exceeds the ${MAX_TRANSCODE_INPUT_BYTES} byte transcode limit.`,
    );
  }
}

/**
 * Real measurement (M8 non-live dry run, 2026-09-08): encoding a real
 * ~4-hour Vexa recording (an artificially long M6 test session — a real
 * customer call would be a fraction of that) to Opus took ~61s at ~237x
 * realtime, narrowly exceeding the previous 60s default and correctly
 * triggering the retry path. A real 30-60 minute meeting would finish in
 * ~10-15s at that same encode speed; this is set generously above even
 * that edge case, not tuned to the common case.
 */
const DEFAULT_TRANSCODE_TIMEOUT_MS = 300_000;

/**
 * Remuxes Vexa's exported recording (a concatenated-chunk WebM/Opus stream
 * that OpenRouter's Whisper backend rejects outright as "unsupported or
 * malformed audio" — confirmed against a real recording during the M8
 * readiness investigation) into a small, cleanly-decodable Opus/Ogg file.
 * ffmpeg was independently confirmed (same investigation) to correctly
 * read straight through the whole concatenated stream. Uses execFile with
 * array arguments — never a shell string — so nothing in inputPath/
 * outputPath (both always caller-generated random temp paths, never
 * derived from external input) can be interpreted as shell syntax.
 */
export async function transcodeToOpusOgg(
  inputPath: string,
  outputPath: string,
  timeoutMs: number = DEFAULT_TRANSCODE_TIMEOUT_MS,
): Promise<void> {
  try {
    await execFileAsync(
      FFMPEG_PATH,
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        outputPath,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      throw new TranscodeTimeoutError();
    }
    // ffmpeg's stderr is technical (codec/format diagnostics) — never
    // customer audio/text — safe to include in the error for debugging.
    throw new TranscodeFailedError(
      `ffmpeg failed: ${err.message ?? "unknown error"}`,
    );
  }
}

export interface AudioProbeResult {
  durationSeconds: number | null;
  hasAudioStream: boolean;
}

/**
 * Sanity-checks the TRANSCODED output before it's handed to the STT
 * provider — a zero-duration or streamless file means the transcode
 * "succeeded" (exit 0) but produced garbage, which should be treated as a
 * transcode failure, not silently sent onward.
 */
export async function probeAudioFile(
  filePath: string,
  timeoutMs = 15_000,
): Promise<AudioProbeResult> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_PATH,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type",
        "-of",
        "json",
        filePath,
      ],
      { timeout: timeoutMs },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string }[];
    };
    const hasAudioStream = (parsed.streams ?? []).some(
      (s) => s.codec_type === "audio",
    );
    const durationSeconds = parsed.format?.duration
      ? Number(parsed.format.duration)
      : null;
    return { durationSeconds, hasAudioStream };
  } catch {
    return { durationSeconds: null, hasAudioStream: false };
  }
}

/**
 * Transcodes raw audio into a 16kHz mono 16-bit PCM WAV file.
 * Used as the deterministic derived-media format for Azure MAI and
 * other providers requiring uncompressed PCM WAV.
 */
export async function transcodeToPcmWav(
  inputPath: string,
  outputPath: string,
  timeoutMs: number = DEFAULT_TRANSCODE_TIMEOUT_MS,
): Promise<void> {
  try {
    await execFileAsync(
      FFMPEG_PATH,
      [
        "-y",
        "-i",
        inputPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        outputPath,
      ],
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
    );
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      signal?: string;
    };
    if (err.killed || err.signal === "SIGTERM") {
      throw new TranscodeTimeoutError();
    }
    throw new TranscodeFailedError(
      `ffmpeg WAV transcode failed: ${err.message ?? "unknown error"}`,
    );
  }
}

export function computeBytesSha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return computeBytesSha256(bytes);
}
