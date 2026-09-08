import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import type {
  EnglishNormalizationProvider,
  TranscriptionProvider,
} from "@applywizz/transcription";
import { probeAudioFile, transcodeToOpusOgg } from "./audio-transcode";

/**
 * M8 real-human language acceptance harness (not part of the production
 * pipeline — see transcription.ts for that). Runs the SAME preprocessing
 * step production does (transcode via ffmpeg) before calling the SAME
 * provider contracts, so results are representative of what the real
 * pipeline would produce — this deliberately does not take a shortcut
 * path just because it's an offline evaluation tool.
 *
 * MINOR/MATERIAL/CRITICAL classification is a judgment call (visa/
 * sponsorship/negation/salary/location semantics) — this harness collects
 * the raw comparison data for that judgment, it does not attempt to
 * automate the classification itself.
 */
export interface ReferenceEntry {
  filename: string;
  spokenReference: string;
  canonicalReference: string;
}

const AUDIO_EXTENSIONS = new Set([
  ".m4a",
  ".mp3",
  ".wav",
  ".ogg",
  ".webm",
  ".flac",
  ".aac",
]);

/**
 * Parses the "# filename\n\nSpoken reference:\n...\n\nCanonical English:\n...\n"
 * block format. Tolerant of blank-line variance between sections; skips
 * (does not throw on) a malformed block, since one bad entry shouldn't
 * block evaluating every other clip.
 */
export function parseReferences(markdown: string): ReferenceEntry[] {
  const entries: ReferenceEntry[] = [];
  const blocks = markdown.split(/^#\s+/m).slice(1);

  for (const block of blocks) {
    const newlineIndex = block.indexOf("\n");
    if (newlineIndex === -1) continue;
    const filename = block.slice(0, newlineIndex).trim();
    const rest = block.slice(newlineIndex + 1);

    const match = rest.match(
      /Spoken reference:\s*\n([\s\S]*?)\n\s*\n\s*Canonical English:\s*\n([\s\S]*?)(?:\n\s*\n|$)/,
    );
    if (!match) continue;

    const spokenReference = match[1]?.trim();
    const canonicalReference = match[2]?.trim();
    if (!filename || !spokenReference || !canonicalReference) continue;

    entries.push({ filename, spokenReference, canonicalReference });
  }

  return entries;
}

export interface ClipEvalResult {
  file: string;
  spokenReference: string;
  canonicalReference: string;
  detectedLanguage: string | null;
  actualTranscript: string;
  actualCanonicalEnglish: string | null;
  durationSeconds: number | null;
  segmentCount: number;
  usageSeconds: number | null;
  usageCost: number | null;
}

export interface ClipEvalFailure {
  file: string;
  error: string;
}

/**
 * Runs ONE clip through the real transcode + transcribe + (conditionally)
 * normalize pipeline — the exact same steps transcription.ts's
 * processTranscriptionJob uses for a real meeting, so this harness's
 * output is representative, not a simplified stand-in. English clips
 * reuse original_text as canonical (same rule as production — "do not
 * unnecessarily rewrite clean English").
 */
export async function evaluateClip(
  inputPath: string,
  reference: ReferenceEntry,
  transcriptionProvider: TranscriptionProvider,
  normalizationProvider: EnglishNormalizationProvider,
): Promise<ClipEvalResult | ClipEvalFailure> {
  const workDir = await mkdtemp(join(tmpdir(), "m8-eval-"));
  try {
    const cleanPath = join(workDir, "clean.ogg");
    await transcodeToOpusOgg(inputPath, cleanPath);

    const probe = await probeAudioFile(cleanPath);
    if (!probe.hasAudioStream) {
      return {
        file: reference.filename,
        error: "Transcode produced no usable audio stream.",
      };
    }

    const result = await transcriptionProvider.transcribe(cleanPath);
    const isEnglish = result.detectedLanguage === "en";

    let canonicalEnglish: string | null = null;
    if (isEnglish) {
      canonicalEnglish = result.text;
    } else if (result.text.trim().length > 0) {
      const normalized = await normalizationProvider.normalize(
        result.text,
        result.detectedLanguage,
      );
      canonicalEnglish = normalized.canonicalEnglishText;
    }

    return {
      file: reference.filename,
      spokenReference: reference.spokenReference,
      canonicalReference: reference.canonicalReference,
      detectedLanguage: result.detectedLanguage,
      actualTranscript: result.text,
      actualCanonicalEnglish: canonicalEnglish,
      durationSeconds: result.durationSeconds,
      segmentCount: result.segments.length,
      usageSeconds: result.usage.seconds,
      usageCost: result.usage.cost,
    };
  } catch (error) {
    return {
      file: reference.filename,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function isFailure(
  result: ClipEvalResult | ClipEvalFailure,
): result is ClipEvalFailure {
  return "error" in result && result.error !== undefined;
}

function renderMarkdownReport(
  results: (ClipEvalResult | ClipEvalFailure)[],
): string {
  return results
    .map((r) => {
      if (isFailure(r)) {
        return `## ${r.file}\n\n**ERROR:** ${r.error}\n`;
      }
      return `## ${r.file}

**Detected language:** ${r.detectedLanguage ?? "unknown"} | **Duration:** ${r.durationSeconds ?? "?"}s | **Cost:** $${r.usageCost ?? "?"}

**Spoken reference:**
${r.spokenReference}

**Actual transcript:**
${r.actualTranscript}

**Canonical English reference:**
${r.canonicalReference}

**Actual canonical English:**
${r.actualCanonicalEnglish ?? "(none — clip produced no usable text)"}

**Classification (fill in during review):** MINOR / MATERIAL / CRITICAL / PASS
**Notes:**
`;
    })
    .join("\n---\n\n");
}

export interface RunEvalHarnessInput {
  audioDir: string;
  transcriptionProvider: TranscriptionProvider;
  normalizationProvider: EnglishNormalizationProvider;
}

export interface RunEvalHarnessResult {
  results: (ClipEvalResult | ClipEvalFailure)[];
  skippedFilesWithNoReference: string[];
  outDir: string;
}

/**
 * Scans audioDir for audio files with a matching entry in
 * audioDir/references.md, evaluates each for real, and writes both a
 * machine-readable (results.json) and human-readable (report.md) report
 * into audioDir/eval-results/.
 */
export async function runEvalHarness(
  input: RunEvalHarnessInput,
): Promise<RunEvalHarnessResult> {
  const referencesPath = join(input.audioDir, "references.md");
  const referencesRaw = await readFile(referencesPath, "utf8");
  const references = parseReferences(referencesRaw);
  const referencesByFilename = new Map(references.map((r) => [r.filename, r]));

  const allFiles = await readdir(input.audioDir);
  const audioFiles = allFiles.filter((f) =>
    AUDIO_EXTENSIONS.has(extname(f).toLowerCase()),
  );

  const results: (ClipEvalResult | ClipEvalFailure)[] = [];
  const skippedFilesWithNoReference: string[] = [];

  for (const file of audioFiles) {
    const reference = referencesByFilename.get(file);
    if (!reference) {
      skippedFilesWithNoReference.push(file);
      continue;
    }
    const result = await evaluateClip(
      join(input.audioDir, file),
      reference,
      input.transcriptionProvider,
      input.normalizationProvider,
    );
    results.push(result);
  }

  const outDir = join(input.audioDir, "eval-results");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await writeFile(join(outDir, "report.md"), renderMarkdownReport(results));

  return { results, skippedFilesWithNoReference, outDir };
}
