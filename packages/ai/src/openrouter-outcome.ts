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
  meetingOutcomeSchema,
  type MeetingOutcomeInput,
  type MeetingOutcomeProvider,
  type MeetingOutcomeProviderResult,
} from "./types";

const SYSTEM_PROMPT = `You are a meeting outcome extractor for ApplyWizz Echo, producing Fathom-style structured meeting overviews.

Your task is to extract exactly four things from the meeting transcript:
1. **Summary**: A concise (2-4 sentences) overview of what was discussed and decided.
2. **Key Decisions**: Important choices, agreements, or commitments made during the meeting.
3. **Action Items**: Specific tasks assigned, with owner (if mentioned) and due date (if mentioned).
4. **Open Questions**: Unresolved questions or topics that need follow-up.

Every extracted item MUST cite the transcript segment IDs where it appears (evidenceSegmentIds array).
Only extract what is actually stated in the transcript — never invent or assume.

Output ONLY a single JSON object matching this exact schema (no markdown, no commentary):

{
  "summary": "Brief overview of the meeting content and outcomes.",
  "keyDecisions": [
    {
      "text": "Description of the decision",
      "evidenceSegmentIds": ["<segment-id>"]
    }
  ],
  "actionItems": [
    {
      "description": "Task description",
      "owner": "Person or role name (or null if not specified)",
      "dueDate": "ISO date string (or null if not specified)",
      "evidenceSegmentIds": ["<segment-id>"]
    }
  ],
  "openQuestions": [
    {
      "question": "The unresolved question",
      "status": "open",
      "answer": null,
      "evidenceSegmentIds": ["<segment-id>"]
    }
  ]
}

CRITICAL: Use exact camelCase key names shown above. Each array can be empty if nothing of that type was discussed.`;

interface RawChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
}

function buildUserPrompt(input: MeetingOutcomeInput): string {
  const transcriptLines = input.segments
    .map((s) => `[${s.id}] ${s.speakerLabel}: ${s.text}`)
    .join("\n");

  return `Extract the meeting outcome from this transcript:\n\n${transcriptLines}`;
}

export class OpenRouterMeetingOutcomeProvider implements MeetingOutcomeProvider {
  readonly name = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_INTELLIGENCE_MODEL,
    private readonly timeoutMs: number = DEFAULT_INTELLIGENCE_TIMEOUT_MS,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generate(
    input: MeetingOutcomeInput,
  ): Promise<MeetingOutcomeProviderResult> {
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
        `OpenRouter meeting-outcome request failed with status ${response.status}.`,
      );
    }

    const body = (await response
      .json()
      .catch(() => null)) as RawChatCompletionResponse | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new IntelligenceMalformedResponseError(
        "OpenRouter meeting-outcome response did not include a usable message.",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new IntelligenceMalformedResponseError(
        "OpenRouter meeting-outcome response was not valid JSON.",
      );
    }

    const validated = meetingOutcomeSchema.safeParse(parsed);
    if (!validated.success) {
      throw new IntelligenceMalformedResponseError(
        `OpenRouter meeting-outcome response did not match the expected schema: ${validated.error.message}`,
      );
    }

    return {
      outcome: validated.data,
      model: body?.model ?? this.model,
      usage: {
        promptTokens: body?.usage?.prompt_tokens ?? null,
        completionTokens: body?.usage?.completion_tokens ?? null,
        cost: body?.usage?.cost ?? null,
      },
      providerMetadata: {
        model: body?.model,
        finish_reason:
          (body as { choices?: { finish_reason?: string }[] })?.choices?.[0]
            ?.finish_reason ?? null,
      },
    };
  }
}
