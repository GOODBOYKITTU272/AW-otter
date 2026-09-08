import { describe, expect, it, vi } from "vitest";
import { OpenRouterMeetingIntelligenceProvider } from "./openrouter-intelligence";
import {
  IntelligenceApiError,
  IntelligenceMalformedResponseError,
  IntelligenceTimeoutError,
} from "./errors";
import type { MeetingIntelligenceInput } from "./types";

const SEG = "11111111-1111-1111-1111-111111111111";

const INPUT: MeetingIntelligenceInput = {
  meetingId: "m1",
  callType: "discovery",
  segments: [
    {
      id: SEG,
      text: "I want Python backend roles.",
      speakerLabel: "speaker_unknown",
    },
  ],
};

function validContent() {
  return JSON.stringify({
    summary: "Customer wants Python backend roles.",
    callRecords: [],
    customerTruthDeltas: [
      {
        fieldKey: "target_roles",
        proposedValue: "Python backend",
        confidence: 0.9,
        evidenceSegmentIds: [SEG],
      },
    ],
    callTypeSpecific: {
      callType: "discovery",
      onboardingCompleteness: { complete: true, missingFields: [] },
      goals: [{ text: "Python backend roles", evidenceSegmentIds: [SEG] }],
    },
  });
}

describe("OpenRouterMeetingIntelligenceProvider", () => {
  it("sends the transcript and call type, and returns a validated result", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(init.body as string);
      expect(body.messages[1].content).toContain("Python backend roles");
      expect(body.messages[1].content).toContain("Call type: discovery");
      return new Response(
        JSON.stringify({
          model: "openai/gpt-4o",
          choices: [{ message: { content: validContent() } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.01 },
        }),
        { status: 200 },
      );
    });

    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await provider.extract(INPUT);
    expect(out.result.summary).toBe("Customer wants Python backend roles.");
    expect(out.result.callTypeSpecific?.callType).toBe("discovery");
    expect(out.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      cost: 0.01,
    });
    expect(out.model).toBe("openai/gpt-4o");
  });

  it("throws IntelligenceApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.extract(INPUT)).rejects.toBeInstanceOf(
      IntelligenceApiError,
    );
  });

  it("throws IntelligenceMalformedResponseError when content is missing", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.extract(INPUT)).rejects.toBeInstanceOf(
      IntelligenceMalformedResponseError,
    );
  });

  it("throws IntelligenceMalformedResponseError when content is not valid JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.extract(INPUT)).rejects.toBeInstanceOf(
      IntelligenceMalformedResponseError,
    );
  });

  it("throws IntelligenceMalformedResponseError when JSON fails schema validation (e.g. missing evidence)", async () => {
    const badContent = JSON.stringify({
      summary: "x",
      callRecords: [
        {
          recordType: "action_item",
          description: "Follow up",
          ownerType: "am",
          evidenceSegmentIds: [], // invalid: min(1)
        },
      ],
      callTypeSpecific: null,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: badContent } }] }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.extract(INPUT)).rejects.toBeInstanceOf(
      IntelligenceMalformedResponseError,
    );
  });

  it("throws IntelligenceTimeoutError when the request aborts", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "test-key",
      undefined,
      20,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.extract(INPUT)).rejects.toBeInstanceOf(
      IntelligenceTimeoutError,
    );
  });

  it("never includes the API key in any thrown error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 401 }));
    const provider = new OpenRouterMeetingIntelligenceProvider(
      "super-secret-key-value",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    try {
      await provider.extract(INPUT);
      throw new Error("expected extract to reject");
    } catch (error) {
      expect((error as Error).message).not.toContain("super-secret-key-value");
    }
  });
});
