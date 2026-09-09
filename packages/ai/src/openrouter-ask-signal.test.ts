import { describe, expect, it, vi } from "vitest";
import { OpenRouterAskSignalProvider } from "./openrouter-ask-signal";
import { AskSignalApiError, AskSignalMalformedResponseError } from "./errors";
import type { AskSignalInput } from "./ask-signal-types";

const INPUT: AskSignalInput = {
  customerId: "cust-1",
  question: "What did we promise them?",
  evidence: [
    {
      type: "call_record",
      id: "cr-1",
      meetingId: "m-1",
      label: "commitment (detected)",
      text: "Send updated resume by Friday.",
    },
  ],
};

function validContent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    answerability: "answered",
    answer: "You promised to send an updated resume by Friday.",
    citedEvidence: [{ type: "call_record", id: "cr-1" }],
    unresolvedAmbiguity: null,
    followUpSuggestions: [],
    ...overrides,
  });
}

describe("OpenRouterAskSignalProvider", () => {
  it("sends the question and evidence, and returns the validated raw model output (unhydrated)", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      const body = JSON.parse(init.body as string);
      expect(body.messages[0].content).not.toContain("Send updated resume");
      expect(body.messages[1].content).toContain("What did we promise them?");
      expect(body.messages[1].content).toContain(
        "Send updated resume by Friday.",
      );
      return new Response(
        JSON.stringify({
          model: "openai/gpt-4o-mini",
          choices: [{ message: { content: validContent() } }],
          usage: { prompt_tokens: 80, completion_tokens: 20, cost: 0.001 },
        }),
        { status: 200 },
      );
    });

    const provider = new OpenRouterAskSignalProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    const out = await provider.respond(INPUT);
    expect(out.result.answerability).toBe("answered");
    expect(out.result.citedEvidence).toEqual([
      { type: "call_record", id: "cr-1" },
    ]);
    // The provider's raw output has NO excerpt field at all — nothing for
    // model-authored text to overwrite the server's real evidence text.
    expect(out.result).not.toHaveProperty("excerpt");
    expect(out.model).toBe("openai/gpt-4o-mini");
  });

  it("throws AskSignalApiError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const provider = new OpenRouterAskSignalProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.respond(INPUT)).rejects.toBeInstanceOf(
      AskSignalApiError,
    );
  });

  it("throws AskSignalMalformedResponseError when content is not valid JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterAskSignalProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.respond(INPUT)).rejects.toBeInstanceOf(
      AskSignalMalformedResponseError,
    );
  });

  it("throws AskSignalMalformedResponseError when an 'answered' response has no citedEvidence (schema-invalid)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "openai/gpt-4o-mini",
            choices: [
              { message: { content: validContent({ citedEvidence: [] }) } },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterAskSignalProvider(
      "test-key",
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    await expect(provider.respond(INPUT)).rejects.toBeInstanceOf(
      AskSignalMalformedResponseError,
    );
  });
});
