import { NextResponse } from "next/server";
import { UnauthenticatedError } from "@applywizz/auth";
import { confirmCustomerTruthFact } from "@applywizz/domain/customer-truth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M10: promotes a proposed Customer Truth fact into confirmed current
// truth. All authorization (admin / customer owner / manager with
// intelligence.read) and the atomic supersede-of-prior-confirmed-fact
// happen inside confirm_customer_truth_fact itself — this route is a
// thin, error-translating wrapper, same shape as
// /api/recording-exceptions.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const supabase = await getSupabaseServerClient();
    const fact = await confirmCustomerTruthFact(supabase, id);
    return NextResponse.json({ fact }, { status: 200 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const pgError = error as { code?: string; message?: string };
    if (pgError.code === "42501") {
      return NextResponse.json({ error: "Not authorized." }, { status: 403 });
    }
    if (pgError.message) {
      // confirm_customer_truth_fact raises a real, human-readable message
      // for "not found" / "not authorized" / blocked-state-transition /
      // concurrent-modification — surface it directly rather than a
      // generic message, per the locked "show the real error" requirement.
      return NextResponse.json({ error: pgError.message }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not confirm this fact." },
      { status: 500 },
    );
  }
}
