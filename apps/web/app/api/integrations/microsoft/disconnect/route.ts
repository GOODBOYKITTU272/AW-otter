import { NextResponse } from "next/server";
import { UnauthenticatedError, getCurrentMembership } from "@applywizz/auth";
import { disconnectMicrosoftConnection } from "@applywizz/domain/microsoft-connection";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  getEncryptionKey,
  getMicrosoftEnv,
  getSupabaseServiceRoleKey,
  toMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  try {
    const supabase = await getSupabaseServerClient();
    const membership = await getCurrentMembership(supabase);

    const { data: connection, error } = await supabase
      .from("calendar_connections")
      .select("id")
      .eq("organization_membership_id", membership.membershipId)
      .eq("provider", "microsoft")
      .maybeSingle();
    if (error) throw error;
    if (!connection) {
      return NextResponse.json(
        { error: "No Microsoft connection to disconnect." },
        { status: 404 },
      );
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    await disconnectMicrosoftConnection(supabase, serviceRoleClient, {
      organizationId: membership.organizationId,
      actorUserId: membership.userId,
      connectionId: connection.id,
      microsoftEnv: toMicrosoftEnv(getMicrosoftEnv()),
      encryptionKey: getEncryptionKey(),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not disconnect Microsoft." },
      { status: 500 },
    );
  }
}
