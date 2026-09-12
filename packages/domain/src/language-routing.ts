import type { TranscriptionProvider } from "@applywizz/transcription";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FFMPEG_PATH = process.env.FFMPEG_PATH || "/usr/bin/ffmpeg";

/**
 * Extracts a short sample from the beginning of an audio file for fast language detection.
 * Returns path to the sample file that must be cleaned up by the caller.
 */
async function extractAudioSample(
  inputPath: string,
  outputPath: string,
  durationSeconds = 30,
  timeoutMs = 30_000,
): Promise<void> {
  await execFileAsync(
    FFMPEG_PATH,
    [
      "-y",
      "-i",
      inputPath,
      "-t",
      String(durationSeconds),
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
}

export interface LanguageDetectionResult {
  detectedLanguage: string | null;
  confidence: number | null;
}

/**
 * Detects language using a fast Whisper pass on a short audio sample.
 * Used for routing decisions before full transcription.
 */
export async function detectLanguage(
  filePath: string,
  whisperProvider: TranscriptionProvider,
  workDir: string,
): Promise<LanguageDetectionResult> {
  const samplePath = join(workDir, "language-sample.ogg");
  try {
    // Extract first 30 seconds for fast detection
    await extractAudioSample(filePath, samplePath, 30);
    
    // Run Whisper for language detection only
    const result = await whisperProvider.transcribe(samplePath);
    
    return {
      detectedLanguage: result.detectedLanguage,
      confidence: null, // Whisper doesn't provide language confidence separately
    };
  } finally {
    // Clean up sample file
    await rm(samplePath, { force: true });
  }
}

export interface LanguageRoutingDecision {
  provider: TranscriptionProvider;
  fallbackProvider?: TranscriptionProvider;
  reason: string;
}

/**
 * Determines which provider to use based on detected language.
 * 
 * Locked product rule (2026-09-12):
 * - English only → Whisper (OpenRouter)
 * - Everything else (Hindi/Indic + all remaining languages) → Sarvam
 * 
 * Fallback policy:
 * - If primary fails, try the other provider
 * - Azure MAI is never used unless explicitly requested
 */
export function routeByLanguage(
  detectedLanguage: string | null,
  whisperProvider: TranscriptionProvider,
  sarvamProvider: TranscriptionProvider | undefined,
  azureProvider: TranscriptionProvider | undefined,
): LanguageRoutingDecision {
  const isEnglish = detectedLanguage?.toLowerCase().startsWith("en") ?? false;

  if (isEnglish) {
    // English → Whisper primary, Sarvam fallback
    return {
      provider: whisperProvider,
      fallbackProvider: sarvamProvider,
      reason: "English detected → Whisper",
    };
  }

  // Non-English → Sarvam primary (if available), Whisper fallback
  if (sarvamProvider) {
    return {
      provider: sarvamProvider,
      fallbackProvider: whisperProvider,
      reason: `${detectedLanguage || "non-English"} detected → Sarvam`,
    };
  }

  // Sarvam not configured, fall back to Whisper
  return {
    provider: whisperProvider,
    fallbackProvider: azureProvider,
    reason: "Sarvam unavailable, using Whisper",
  };
}

/**
 * Determines provider selection strategy based on configuration.
 * Returns whether to use language-based routing (true) or legacy provider selection (false).
 */
export function shouldUseLanguageRouting(
  primaryProviderName: string,
  enableLanguageRouting?: boolean,
): boolean {
  // Language routing is enabled by default unless explicitly disabled
  // OR if Azure MAI is explicitly requested as primary (legacy compatibility)
  if (enableLanguageRouting === false) {
    return false;
  }
  if (primaryProviderName === "azure-mai") {
    return false; // Legacy Azure-first chain for backward compatibility
  }
  return true;
}
