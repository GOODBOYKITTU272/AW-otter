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
  inviteMembership,
} from "@applywizz/domain/people";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getAppBaseUrl, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
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

    // Narrowest possible service-role use: one admin API call, not a wider
    // service-role client for the rest of this RLS-scoped request. Never
    // blocks the response on failure — the membership itself is already a
    // real, useful record; the caller is told so they can retry the invite.
    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );
    const { error: inviteError } = await inviteMembership(serviceRoleClient, {
      workEmail: person.work_email,
      displayName: person.display_name,
      redirectTo: `${getAppBaseUrl()}/auth/set-password`,
    });

    return NextResponse.json(
      {
        person,
        inviteWarning: inviteError
          ? `Person created, but the invite email failed to send: ${inviteError}`
          : null,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
