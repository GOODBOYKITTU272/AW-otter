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
  updatePerson,
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
  console.error("People update failed:", pgError?.code ?? pgError?.name);
  return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await getSupabaseServerClient();
    await requirePermission(supabase, "people.manage");
    const body = await request.json();

    const person = await updatePerson(supabase, id, {
      displayName: body.displayName,
      roleId: body.roleId,
      managerMembershipId:
        "managerMembershipId" in body ? body.managerMembershipId : undefined,
      departmentId: "departmentId" in body ? body.departmentId : undefined,
      teamId: "teamId" in body ? body.teamId : undefined,
      meetingAiEnabled: body.meetingAiEnabled,
      status: body.status,
    });

    return NextResponse.json({ person });
  } catch (error) {
    return errorResponse(error);
  }
}
