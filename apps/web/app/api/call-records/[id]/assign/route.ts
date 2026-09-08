import { NextResponse } from "next/server";
import { UnauthenticatedError } from "@applywizz/auth";
import { assignCallRecordOwner } from "@applywizz/domain/call-records";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    if (
      typeof body.ownerMembershipId !== "string" ||
      body.ownerMembershipId.length === 0
    ) {
      return NextResponse.json(
        { error: "ownerMembershipId is required." },
        { status: 400 },
      );
    }
    const dueAt =
      typeof body.dueAt === "string" && body.dueAt.length > 0
        ? body.dueAt
        : undefined;

    const supabase = await getSupabaseServerClient();
    const record = await assignCallRecordOwner(
      supabase,
      id,
      body.ownerMembershipId,
      dueAt,
    );
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
      { error: "Could not assign an owner." },
      { status: 500 },
    );
  }
}
