import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  EnglishNormalizationProvider,
  TranscriptionProvider,
} from "@applywizz/transcription";
import {
  evaluateClip,
  parseReferences,
  runEvalHarness,
} from "./m8-language-eval";

const execFileAsync = promisify(execFile);

const SAMPLE_REFERENCES_MD = `# english_01.m4a

Spoken reference:
I want to target backend software engineer roles.

Canonical English:
I want to target backend software engineer roles.


# telugu_mix_01.m4a

Spoken reference:
Python side ki shift avvali, backend roles ekkuva target cheddam.

Canonical English:
Shift toward Python and target more backend roles.
`;

describe("parseReferences", () => {
  it("parses both entries with their spoken and canonical references", () => {
    const entries = parseReferences(SAMPLE_REFERENCES_MD);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      filename: "english_01.m4a",
      spokenReference: "I want to target backend software engineer roles.",
      canonicalReference: "I want to target backend software engineer roles.",
    });
    expect(entries[1]).toEqual({
      filename: "telugu_mix_01.m4a",
      spokenReference:
        "Python side ki shift avvali, backend roles ekkuva target cheddam.",
      canonicalReference: "Shift toward Python and target more backend roles.",
    });
  });

  it("skips a malformed block instead of throwing", () => {
    const entries = parseReferences(
      "# broken.m4a\n\nNo sections here at all.\n",
    );
    expect(entries).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseReferences("")).toEqual([]);
  });
});

let scratchDir: string;

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "m8-eval-test-"));
});

afterEach(async () => {
  // per-test cleanup happens inside evaluateClip itself; this just
  // clears anything the test created directly in scratchDir's audio dir.
});

async function generateSilentAudio(path: string, seconds = 1): Promise<void> {
  // Codec must actually fit the target container — .m4a needs aac,
  // .webm needs opus/vorbis (mismatching either is a real ffmpeg error,
  // not something the harness should paper over).
  const codec = path.endsWith(".m4a") ? "aac" : "libopus";
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    String(seconds),
    "-c:a",
    codec,
    path,
  ]);
}

function fakeTranscriptionProvider(
  text: string,
  language: string,
): TranscriptionProvider {
  return {
    name: "fake",
    transcribe: async () => ({
      text,
      detectedLanguage: language,
      durationSeconds: 1,
      segments: [{ index: 0, startMs: 0, endMs: 900, text, confidence: 0.9 }],
      words: null,
      model: "fake-model",
      usage: { seconds: 1, cost: 0.0001 },
      providerMetadata: {},
    }),
  };
}

function fakeNormalizationProvider(
  canonical: string,
): EnglishNormalizationProvider {
  return {
    name: "fake",
    normalize: async () => ({
      canonicalEnglishText: canonical,
      confidence: null,
    }),
  };
}

describe("evaluateClip", () => {
  it("runs the real transcode step, then the given providers, for an English clip", async () => {
    const inputPath = join(scratchDir, "english.webm");
    await generateSilentAudio(inputPath);

    const result = await evaluateClip(
      inputPath,
      {
        filename: "english.webm",
        spokenReference: "hello",
        canonicalReference: "hello",
      },
      fakeTranscriptionProvider("We should shift toward Python.", "en"),
      fakeNormalizationProvider("unused for English"),
    );

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected a success result");
    expect(result.actualTranscript).toBe("We should shift toward Python.");
    // English reuses original_text as canonical — normalization is never called.
    expect(result.actualCanonicalEnglish).toBe(
      "We should shift toward Python.",
    );
    expect(result.detectedLanguage).toBe("en");
  });

  it("calls the normalization provider for a non-English clip", async () => {
    const inputPath = join(scratchDir, "telugu.webm");
    await generateSilentAudio(inputPath);

    const result = await evaluateClip(
      inputPath,
      {
        filename: "telugu.webm",
        spokenReference: "Python side ki shift avvali.",
        canonicalReference: "Shift toward Python.",
      },
      fakeTranscriptionProvider("Python side ki shift avvali.", "te"),
      fakeNormalizationProvider("Shift toward Python."),
    );

    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error("expected a success result");
    expect(result.detectedLanguage).toBe("te");
    expect(result.actualCanonicalEnglish).toBe("Shift toward Python.");
  });

  it("returns a failure result (not a thrown error) when transcode fails on a bad input file", async () => {
    const inputPath = join(scratchDir, "not-audio.webm");
    await writeFile(inputPath, "not real audio data");

    const result = await evaluateClip(
      inputPath,
      {
        filename: "not-audio.webm",
        spokenReference: "x",
        canonicalReference: "x",
      },
      fakeTranscriptionProvider("should not be reached", "en"),
      fakeNormalizationProvider("should not be reached"),
    );

    expect("error" in result && !!result.error).toBe(true);
  });
});

describe("runEvalHarness", () => {
  it("evaluates every audio file with a matching reference and writes both report files", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "m8-eval-harness-"));
    try {
      await generateSilentAudio(join(audioDir, "english_01.m4a"));
      await generateSilentAudio(join(audioDir, "telugu_mix_01.m4a"));
      await generateSilentAudio(join(audioDir, "no_reference.m4a"));
      await writeFile(join(audioDir, "references.md"), SAMPLE_REFERENCES_MD);

      const { results, skippedFilesWithNoReference, outDir } =
        await runEvalHarness({
          audioDir,
          transcriptionProvider: fakeTranscriptionProvider(
            "Python side ki shift avvali.",
            "te",
          ),
          normalizationProvider: fakeNormalizationProvider(
            "Shift toward Python.",
          ),
        });

      expect(results).toHaveLength(2);
      expect(skippedFilesWithNoReference).toEqual(["no_reference.m4a"]);

      const resultsJson = JSON.parse(
        await readFile(join(outDir, "results.json"), "utf8"),
      );
      expect(resultsJson).toHaveLength(2);

      const reportMd = await readFile(join(outDir, "report.md"), "utf8");
      expect(reportMd).toContain("english_01.m4a");
      expect(reportMd).toContain("telugu_mix_01.m4a");
      expect(reportMd).toContain("Classification (fill in during review)");
    } finally {
      await rm(audioDir, { recursive: true, force: true });
    }
  });

  it("throws a clear error when references.md is missing", async () => {
    const audioDir = await mkdtemp(join(tmpdir(), "m8-eval-no-refs-"));
    try {
      await mkdir(audioDir, { recursive: true });
      await expect(
        runEvalHarness({
          audioDir,
          transcriptionProvider: fakeTranscriptionProvider("x", "en"),
          normalizationProvider: fakeNormalizationProvider("x"),
        }),
      ).rejects.toThrow();
    } finally {
      await rm(audioDir, { recursive: true, force: true });
    }
  });
});
