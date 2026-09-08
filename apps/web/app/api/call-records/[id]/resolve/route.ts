import { NextResponse } from "next/server";
import { UnauthenticatedError } from "@applywizz/auth";
import { resolveCallRecord } from "@applywizz/domain/call-records";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    if (body.resolution !== "completed" && body.resolution !== "cancelled") {
      return NextResponse.json(
        { error: "resolution must be 'completed' or 'cancelled'." },
        { status: 400 },
      );
    }
    const note =
      typeof body.note === "string" && body.note.trim().length > 0
        ? body.note.trim()
        : undefined;

    const supabase = await getSupabaseServerClient();
    const record = await resolveCallRecord(supabase, id, body.resolution, note);
    return NextResponse.json({ record }, { status: 200 });
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
      { error: "Could not resolve this action." },
      { status: 500 },
    );
  }
}
