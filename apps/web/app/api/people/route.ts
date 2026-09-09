import { NextResponse } from "next/server";
import {
  ForbiddenError,
  UnauthenticatedError,
  requirePermission,
} from "@applywizz/auth";
import {
  CircularReportingError,
  CrossOrganizationAssignmentError,
  DuplicateWorkEmailError,
  SelfManagementError,
  createPerson,
} from "@applywizz/domain/people";
import { getSupabaseServerClient } from "@/lib/supabase/server";

function errorResponse(error: unknown) {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (
    error instanceof DuplicateWorkEmailError ||
    error instanceof CrossOrganizationAssignmentError ||
    error instanceof SelfManagementError ||
    error instanceof CircularReportingError
  ) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  // M15 audit (P2, fixed): work_email carries a unique constraint, and
  // Postgres embeds the actual conflicting VALUE in a 23505 violation's
  // DETAIL message — an unanticipated constraint hit here (anything not
  // already caught as DuplicateWorkEmailError above) could otherwise log
  // a real employee email address. Same safer convention as
  // hydrate-crm's error logging: name/code only, never the raw error.
  const pgError = error as { name?: string; code?: string };
  console.error("People create failed:", pgError?.code ?? pgError?.name);
  return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
}

export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await requirePermission(supabase, "people.manage");
    const body = await request.json();

    if (!body.workEmail || !body.displayName || !body.roleId) {
      return NextResponse.json(
        { error: "workEmail, displayName and roleId are required." },
        { status: 400 },
      );
    }

    const person = await createPerson(supabase, {
      organizationId: membership.organizationId,
      workEmail: body.workEmail,
      displayName: body.displayName,
      roleId: body.roleId,
      managerMembershipId: body.managerMembershipId ?? null,
      departmentId: body.departmentId ?? null,
      teamId: body.teamId ?? null,
      meetingAiEnabled: body.meetingAiEnabled ?? true,
    });

    return NextResponse.json({ person }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
