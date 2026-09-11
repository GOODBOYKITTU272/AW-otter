import { NextResponse } from "next/server";
import {
  requireAuthenticatedUser,
  UnauthenticatedError,
} from "@applywizz/auth";
import {
  answerCustomerQuestion,
  CustomerNotVisibleError,
} from "@applywizz/domain/ask-signal";
import {
  AskSignalApiError,
  AskSignalMalformedResponseError,
  AskSignalTimeoutError,
  OpenRouterAskSignalProvider,
} from "@applywizz/ai";
import { getOpenRouterEnv } from "@/env/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

const MAX_QUESTION_LENGTH = 500;

// M13 vertical slice: mutation-shaped POST (same reasoning as
// hydrate-crm) even though it's a read — it triggers a real external-cost
// LLM call, never cacheable. Every read inside answerCustomerQuestion goes
// through THIS request's own caller-scoped `supabase` client — no
// service-role client exists anywhere on this path.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = (await request.json().catch(() => null)) as {
      question?: unknown;
    } | null;
    const question =
      typeof body?.question === "string" ? body.question.trim() : "";
    if (question.length === 0 || question.length > MAX_QUESTION_LENGTH) {
      return NextResponse.json(
        { error: "Question must be non-empty and at most 500 characters." },
        { status: 400 },
      );
    }

    const supabase = await getSupabaseServerClient();
    // Codex M13 Pass 2 SHOULD-FIX (fixed): the caught UnauthenticatedError
    // path below was dead — nothing previously threw it, so an
    // unauthenticated caller fell through to the RLS-hidden-customer 404
    // instead of the intended 401.
    const user = await requireAuthenticatedUser(supabase);
    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (customerError) throw customerError;
    // Same "don't reveal existence" posture as hydrateCustomerCrmBaseline
    // — RLS-filtered-out and genuinely-missing both look like 404.
    if (!customer) throw new CustomerNotVisibleError();

    const openRouterEnv = getOpenRouterEnv();
    const provider = new OpenRouterAskSignalProvider(
      openRouterEnv.OPENROUTER_API_KEY,
    );

    const result = await answerCustomerQuestion(
      supabase,
      provider,
      id,
      question,
      user.id,
    );
    return NextResponse.json({ result }, { status: 200 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof CustomerNotVisibleError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof AskSignalTimeoutError ||
      error instanceof AskSignalApiError ||
      error instanceof AskSignalMalformedResponseError
    ) {
      // §9: never a partial/fabricated answer, never logs the
      // question/evidence text — only the error's own name/status.
      console.error("Ask Signal provider failed:", error.name);
      return NextResponse.json(
        { error: "Ask Signal could not answer that right now." },
        { status: 502 },
      );
    }
    console.error("Ask Signal request failed:", (error as Error)?.name);
    return NextResponse.json(
      { error: "Ask Signal could not answer that right now." },
      { status: 500 },
    );
  }
}
