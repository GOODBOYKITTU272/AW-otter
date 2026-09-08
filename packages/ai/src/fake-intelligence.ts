import type {
  MeetingIntelligenceInput,
  MeetingIntelligenceProvider,
  MeetingIntelligenceProviderResult,
  MeetingIntelligenceResult,
} from "./types";

/**
 * Test double mirroring FakeMeetingBotProvider's contract-fidelity
 * approach (packages/meeting-bots/src/fake-provider.ts) — returns a
 * caller-supplied, already-schema-valid result so domain-layer tests never
 * need a real OpenRouter call. `extractCalls` records every invocation for
 * idempotency/retry assertions.
 */
export class FakeMeetingIntelligenceProvider
  implements MeetingIntelligenceProvider
{
  readonly name = "fake";
  readonly extractCalls: MeetingIntelligenceInput[] = [];

  constructor(
    private readonly response:
      | MeetingIntelligenceProviderResult
      | (() => MeetingIntelligenceProviderResult),
  ) {}

  async extract(
    input: MeetingIntelligenceInput,
  ): Promise<MeetingIntelligenceProviderResult> {
    this.extractCalls.push(input);
    return typeof this.response === "function"
      ? this.response()
      : this.response;
  }
}

export function fakeResult(
  overrides: Partial<MeetingIntelligenceResult> = {},
): MeetingIntelligenceResult {
  return {
    summary: "The customer discussed their job search goals.",
    callRecords: [],
    customerTruthDeltas: [],
    callTypeSpecific: null,
    ...overrides,
  };
}
