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
  console.error(error);
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
