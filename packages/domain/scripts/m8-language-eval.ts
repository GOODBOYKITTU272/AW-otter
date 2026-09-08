// M8 real-human language acceptance harness — manual tool, not part of the
// automated build/test gate. Run from the repo root with:
//   OPENROUTER_API_KEY=... pnpm exec tsx packages/domain/scripts/m8-language-eval.ts [audio-dir]
//
// Reads <audio-dir>/references.md (see the format the product owner
// specified — "# filename" header, "Spoken reference:" / "Canonical
// English:" sections), runs each matching audio file through the real
// production TranscriptionProvider/EnglishNormalizationProvider (same
// classes transcription.ts uses — this is not a simplified stand-in), and
// writes <audio-dir>/eval-results/{results.json,report.md}.
//
// Never logs the API key. Never logs full transcript text to the
// terminal (only a per-file completion line) — the full text goes to the
// report files only.

import {
  OpenRouterNormalizationProvider,
  OpenRouterTranscriptionProvider,
} from "@applywizz/transcription";
import { runEvalHarness } from "../src/m8-language-eval";

async function main() {
  const audioDir = process.argv[2] ?? "m8-audio";
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "Set OPENROUTER_API_KEY in the environment before running this script.",
    );
    process.exit(1);
  }

  const transcriptionProvider = new OpenRouterTranscriptionProvider(apiKey);
  const normalizationProvider = new OpenRouterNormalizationProvider(apiKey);

  console.log(`Running M8 language evaluation against: ${audioDir}`);
  const { results, skippedFilesWithNoReference, outDir } = await runEvalHarness(
    {
      audioDir,
      transcriptionProvider,
      normalizationProvider,
    },
  );

  for (const result of results) {
    if ("error" in result && result.error) {
      console.log(`  ${result.file}: ERROR — ${result.error}`);
    } else {
      console.log(
        `  ${result.file}: ok (${"detectedLanguage" in result ? result.detectedLanguage : "?"})`,
      );
    }
  }

  if (skippedFilesWithNoReference.length > 0) {
    console.log(
      `\nSkipped (no matching entry in references.md): ${skippedFilesWithNoReference.join(", ")}`,
    );
  }

  console.log(`\nWrote ${results.length} result(s) to ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
