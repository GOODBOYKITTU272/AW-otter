import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import {
  createCustomer,
  addCustomerContact,
} from "@applywizz/domain/customers";
import { linkMeetingToCustomer } from "@applywizz/domain/customer-linkage";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// AM/Admin-initiated "create a temporary Signal customer" — the M7A
// needs_link resolution path (design doc §6). Optionally links a
// just-created customer to the meeting that prompted its creation in the
// same call, so the AM doesn't need a second round trip.
export async function POST(request: Request) {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);
    const body = await request.json();

    if (!body.name || typeof body.name !== "string") {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }

    const { customerId } = await createCustomer(supabase, {
      organizationId: membership.organizationId,
      name: body.name,
      ownerMembershipId:
        typeof body.ownerMembershipId === "string" &&
        body.ownerMembershipId.length > 0
          ? body.ownerMembershipId
          : membership.membershipId,
      actorMembershipId: membership.membershipId,
      actorUserId: membership.userId,
    });

    if (body.contactEmail && typeof body.contactEmail === "string") {
      await addCustomerContact(supabase, {
        organizationId: membership.organizationId,
        customerId,
        email: body.contactEmail,
        actorUserId: membership.userId,
      });
    }

    if (body.linkMeetingId && typeof body.linkMeetingId === "string") {
      const clientEnv = getClientEnv();
      const serviceRoleClient = createSupabaseServiceRoleClient(
        clientEnv.NEXT_PUBLIC_SUPABASE_URL,
        getSupabaseServiceRoleKey(),
      );
      await linkMeetingToCustomer(supabase, serviceRoleClient, {
        meetingId: body.linkMeetingId,
        organizationId: membership.organizationId,
        customerId,
        actorMembershipId: membership.membershipId,
        actorRoleKey: membership.roleKey,
        actorUserId: membership.userId,
      });
    }

    return NextResponse.json({ customerId }, { status: 201 });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (
      error instanceof Error &&
      /required|already associated|owned by the same/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      /not authorized to manage/i.test(error.message)
    ) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    const pgError = error as { code?: string };
    if (pgError.code === "42501") {
      return NextResponse.json(
        { error: "Not authorized to create this customer." },
        { status: 403 },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not create the customer." },
      { status: 500 },
    );
  }
}
