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

const SYSTEM_PROMPT = `You are a meeting outcome extractor for ApplyWizz Echo, producing Fathom-style structured meeting overviews for executives.

Extract exactly four things from the meeting transcript:
1. **Summary**: 2-4 calm sentences covering the main topics AND concrete outcomes/proposals (not "no resolution" unless truly nothing was proposed).
2. **Key Decisions**: Directions the speaker(s) committed to or clearly proposed as the plan (naming, branding/logo, capacity targets, dispatch timing, storage approach). If someone says "let's do X" / "I want X" / "we should X", capture it as a decision or action — do not leave Key Decisions empty when proposals were made.
3. **Action Items**: Specific follow-up tasks with owner when named. Proposals like "store bot IDs in Supabase and trigger 90 seconds before" ARE action items.
4. **Open Questions**: Only unresolved questions that still need an answer (e.g. screen recording status). Do not duplicate the same question.

Evidence rules (CRITICAL):
- Every item MUST cite evidenceSegmentIds using ONLY segment IDs that appear in the transcript lines below (the bracketed UUIDs).
- Cite the segment whose text best supports THAT item. Do not reuse one mega-segment opener for unrelated items when another segment (or a more topical part) fits better.
- Prefer distinct evidenceSegmentIds across unrelated items.
- Never invent segment IDs. Never invent facts not stated in the transcript.
- Do not invent metrics, logos shipped, or guest-browser claims.

Output ONLY a single JSON object matching this exact schema (no markdown, no commentary):

{
  "summary": "Brief overview of the meeting content and outcomes.",
  "keyDecisions": [
    {
      "text": "Description of the decision or committed direction",
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

CRITICAL: Use exact camelCase key names shown above. Arrays may be empty only when nothing of that type was discussed.`;

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

  return `Extract the meeting outcome from this transcript. Use only the bracketed segment UUIDs as evidenceSegmentIds.
Capture naming, logo/branding, concurrency capacity targets, dispatch timing, and storage/trigger plans as decisions or action items when proposed — not only as open questions.

${transcriptLines}`;
}

/** Keep only segment IDs that exist in the input transcript. */
function filterToKnownSegmentIds(
  ids: string[],
  known: Set<string>,
): string[] {
  return ids.filter((id) => known.has(id));
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

    const knownIds = new Set(input.segments.map((s) => s.id));
    const fallbackId = input.segments[0]?.id;
    const ensureIds = (ids: string[]): string[] => {
      const filtered = filterToKnownSegmentIds(ids, knownIds);
      if (filtered.length > 0) return filtered;
      return fallbackId ? [fallbackId] : filtered;
    };

    const outcome = {
      summary: validated.data.summary,
      keyDecisions: validated.data.keyDecisions.map((d) => ({
        ...d,
        evidenceSegmentIds: ensureIds(d.evidenceSegmentIds),
      })),
      actionItems: validated.data.actionItems.map((a) => ({
        ...a,
        evidenceSegmentIds: ensureIds(a.evidenceSegmentIds),
      })),
      openQuestions: validated.data.openQuestions.map((q) => ({
        ...q,
        evidenceSegmentIds: ensureIds(q.evidenceSegmentIds),
      })),
    };

    return {
      outcome,
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
