import { type NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getMicrosoftEnv, getSupabaseServiceRoleKey } from "@/env/server";
import { getClientEnv } from "@/env/client";

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
}

// M3 scope: keep the subscription alive and record that a notification
// arrived. Turning notifications into canonical meeting changes is M4's
// job — this handler does no such processing.
export async function POST(request: NextRequest) {
  // Graph's subscription validation handshake: echo the token back as
  // text/plain. No membership/org identity is involved in this step at all.
  const validationToken = request.nextUrl.searchParams.get("validationToken");
  if (validationToken !== null) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const body = await request.json().catch(() => null);
  const notifications: GraphNotification[] = Array.isArray(body?.value)
    ? body.value
    : [];
  const { MICROSOFT_WEBHOOK_CLIENT_STATE } = getMicrosoftEnv();

  const clientEnv = getClientEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  for (const notification of notifications) {
    // Never trust org/membership identifiers from the payload — clientState
    // must match ours, and the subscription is looked up by an id WE
    // generated and stored, resolving connection/membership server-side.
    if (notification.clientState !== MICROSOFT_WEBHOOK_CLIENT_STATE) continue;
    if (!notification.subscriptionId) continue;

    const { error } = await serviceRoleClient
      .from("provider_subscriptions")
      .update({ last_notification_at: new Date().toISOString() })
      .eq("external_subscription_id", notification.subscriptionId);
    if (error) {
      console.error("Failed to record Microsoft calendar notification", error);
    }
  }

  return NextResponse.json({ received: true }, { status: 202 });
}
