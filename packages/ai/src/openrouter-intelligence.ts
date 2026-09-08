import {
  DEFAULT_INTELLIGENCE_MODEL,
  DEFAULT_INTELLIGENCE_TIMEOUT_MS,
  OPENROUTER_BASE_URL,
} from "./config";
import {
  IntelligenceApiError,
  IntelligenceMalformedResponseError,
  IntelligenceTimeoutError,
} from "./errors";
import {
  meetingIntelligenceResultSchema,
  type MeetingIntelligenceInput,
  type MeetingIntelligenceProvider,
  type MeetingIntelligenceProviderResult,
} from "./types";

const SYSTEM_PROMPT = `You are an evidence-grade meeting intelligence extractor for ApplyWizz Signal, a company-controlled meeting intelligence product for job-search account managers (AMs) and their customers.

You will be given a meeting's call type (or "unknown") and its transcript, as an ordered list of segments each with a stable id and speaker label.

Extract ONLY what is actually stated or clearly implied in the transcript. Never invent facts, never assume unstated context, never fabricate a customer state. If something is unclear or not discussed, omit it rather than guessing.

Every claim you extract (a goal, a concern, a change request, etc.) MUST cite the id(s) of the transcript segment(s) it came from in its evidenceSegmentIds array. A claim with no supporting segment must not be included.

Output ONLY a single JSON object matching the provided schema. No commentary, no markdown, no explanation outside the JSON.

Fields:
- summary: a concise (3-6 sentence) factual summary of what was discussed and decided in this call.
- callRecords: action items, commitments, decisions, questions, and blockers raised in the call. Each needs a clear ownerType (who owns it: customer, am, resume_team, applywizz, or other) and at least one evidenceSegmentIds entry.
- customerTruthDeltas: any stated change or addition to the customer's preferences/requirements (target roles, skills, avoid roles, locations, relocation, work mode, compensation, work authorization, sponsorship, company/industry preferences, resume positioning, concerns, application strategy). Use a stable fieldKey (snake_case). Only include deltas that are actually stated in this call.
- callTypeSpecific: if call type is known, fill in the shape for that exact call type (discovery/resume_review/orientation/progress/renewal). If call type is "unknown" or not provided, set this to null and do not attempt call-type-specific extraction.`;

interface RawChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

function buildUserPrompt(input: MeetingIntelligenceInput): string {
  const transcriptLines = input.segments
    .map((s) => `[${s.id}] ${s.speakerLabel}: ${s.text}`)
    .join("\n");
  const priorLines =
    input.priorContext && input.priorContext.openCallRecords.length > 0
      ? `\n\nStill-open items from prior meetings (reference by their own id via carriedFromPriorRecordId if this call reiterates one — not part of the output schema yet, ignore for now if unsure):\n${input.priorContext.openCallRecords
          .map((r) => `[${r.id}] ${r.description}`)
          .join("\n")}`
      : "";

  return `Call type: ${input.callType ?? "unknown"}\n\nTranscript:\n${transcriptLines}${priorLines}`;
}

/**
 * First concrete implementation of MeetingIntelligenceProvider (locked
 * architecture: provider-neutral contract, OpenRouter is swappable — same
 * posture as packages/transcription). Requests response_format=json_object
 * (broadest OpenRouter/model compatibility) but NEVER trusts the provider's
 * own output shape — meetingIntelligenceResultSchema.safeParse is the
 * actual validation gate, same as M8's "structured JSON is validated
 * before persistence" rule. A stricter json_schema response_format is a
 * possible future tightening, not required for correctness here.
 */
export class OpenRouterMeetingIntelligenceProvider
  implements MeetingIntelligenceProvider
{
  readonly name = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_INTELLIGENCE_MODEL,
    private readonly timeoutMs: number = DEFAULT_INTELLIGENCE_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async extract(
    input: MeetingIntelligenceInput,
  ): Promise<MeetingIntelligenceProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            temperature: 0.1,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: buildUserPrompt(input) },
            ],
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new IntelligenceTimeoutError();
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new IntelligenceApiError(
        response.status,
        `OpenRouter meeting-intelligence request failed with status ${response.status}.`,
      );
    }

    const body = (await response
      .json()
      .catch(() => null)) as RawChatCompletionResponse | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new IntelligenceMalformedResponseError(
        "OpenRouter meeting-intelligence response did not include a usable message.",
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      throw new IntelligenceMalformedResponseError(
        "OpenRouter meeting-intelligence response was not valid JSON.",
      );
    }

    const validated = meetingIntelligenceResultSchema.safeParse(parsedJson);
    if (!validated.success) {
      throw new IntelligenceMalformedResponseError(
        `OpenRouter meeting-intelligence response failed schema validation: ${validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    return {
      result: validated.data,
      model: body?.model ?? this.model,
      usage: {
        promptTokens: body?.usage?.prompt_tokens ?? null,
        completionTokens: body?.usage?.completion_tokens ?? null,
        cost: body?.usage?.cost ?? null,
      },
      providerMetadata: {
        model: body?.model ?? this.model,
      },
    };
  }
}
