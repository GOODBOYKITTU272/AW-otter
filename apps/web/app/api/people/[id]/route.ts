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
  console.error(error);
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
