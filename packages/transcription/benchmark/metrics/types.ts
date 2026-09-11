export type BenchmarkLanguage = "en" | "hi" | "te" | "en-hi" | "en-te";
export type BenchmarkSpeakerRole = "am" | "candidate" | "other";

export interface BenchmarkWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface BenchmarkGroundTruthSegment {
  id: string;
  startMs: number;
  endMs: number;
  speakerRole: BenchmarkSpeakerRole;
  speakerId: string;
  language: BenchmarkLanguage;
  text: string;
  isCodeSwitched: boolean;
  words?: BenchmarkWord[];
  notes?: string;
}

export interface BenchmarkMetadata {
  id: string;
  audioFilename: string;
  durationSeconds: number;
  category:
    | "clean_indian_en"
    | "noisy_indian_en"
    | "conversational_hi"
    | "conversational_te"
    | "code_switch_en_hi"
    | "code_switch_en_te"
    | "multi_speaker_overlap"
    | "background_distractor";
  primaryLanguage: BenchmarkLanguage;
  speakers: {
    id: string;
    role: BenchmarkSpeakerRole;
    nameHint?: string;
  }[];
  audioCharacteristics: {
    snrCategory: "high" | "medium" | "low";
    backgroundNoise: boolean;
    crosstalkPresent: boolean;
  };
}

export interface BenchmarkCase {
  metadata: BenchmarkMetadata;
  groundTruthSegments: BenchmarkGroundTruthSegment[];
}

export interface BenchmarkEvaluationResult {
  caseId: string;
  model: string;
  wer: number;
  cer?: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWordCount: number;
  hypothesisWordCount: number;
  codeSwitchPreservationRate?: number;
  diarizationErrorRate?: number;
  speakerAttributionAccuracy?: number;
  durationMs: number;
}
