import { NextResponse } from "next/server";
import { UnauthenticatedError } from "@applywizz/auth";
import { rejectCustomerTruthFact } from "@applywizz/domain/customer-truth";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const reason =
      typeof body.reason === "string" && body.reason.trim().length > 0
        ? body.reason.trim()
        : undefined;

    const supabase = await getSupabaseServerClient();
    const fact = await rejectCustomerTruthFact(supabase, id, reason);
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
      return NextResponse.json({ error: pgError.message }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not reject this fact." },
      { status: 500 },
    );
  }
}
