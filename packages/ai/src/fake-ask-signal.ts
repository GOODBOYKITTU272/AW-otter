import type {
  AskSignalInput,
  AskSignalModelOutput,
  AskSignalProvider,
  AskSignalProviderResult,
} from "./ask-signal-types";

/** Test double mirroring FakeMeetingIntelligenceProvider — returns a caller-supplied, already-schema-valid raw model output so domain-layer tests never need a real OpenRouter call. */
export class FakeAskSignalProvider implements AskSignalProvider {
  readonly name = "fake";
  readonly respondCalls: AskSignalInput[] = [];

  constructor(
    private readonly response:
      AskSignalProviderResult | (() => AskSignalProviderResult),
  ) {}

  async respond(input: AskSignalInput): Promise<AskSignalProviderResult> {
    this.respondCalls.push(input);
    return typeof this.response === "function"
      ? this.response()
      : this.response;
  }
}

// Codex M13 Pass 2 NIT (fixed): the old default (`answered` + empty
// `citedEvidence`) violated askSignalModelOutputSchema's own superRefine
// rule — it only ever worked because every caller overrides one of the
// two fields. `insufficient_evidence` + `[]` is schema-valid on its own;
// callers testing a real cited answer must override both explicitly.
export function fakeAskSignalModelOutput(
  overrides: Partial<AskSignalModelOutput> = {},
): AskSignalModelOutput {
  return {
    answerability: "insufficient_evidence",
    answer: "Not enough evidence to answer that.",
    citedEvidence: [],
    unresolvedAmbiguity: null,
    followUpSuggestions: [],
    ...overrides,
  };
}
