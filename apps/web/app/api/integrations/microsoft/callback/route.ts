import { type NextRequest, NextResponse } from "next/server";
import { getCurrentMembership } from "@applywizz/auth";
import { validateState } from "@applywizz/microsoft";
import { completeMicrosoftConnection } from "@applywizz/domain/microsoft-connection";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  getAppBaseUrl,
  getEncryptionKey,
  getMicrosoftEnv,
  getSupabaseServiceRoleKey,
  getWebhookBaseUrl,
  toMicrosoftEnv,
} from "@/env/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const appBaseUrl = getAppBaseUrl();
  const params = request.nextUrl.searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const providerError = params.get("error");
  const cookieState = request.cookies.get("ms_oauth_state")?.value ?? null;

  function redirectWithError(message: string) {
    const url = new URL("/integrations", appBaseUrl);
    url.searchParams.set("microsoft_error", message);
    const response = NextResponse.redirect(url);
    response.cookies.delete("ms_oauth_state");
    return response;
  }

  // Never mark anything Connected on a rejected/invalid/expired attempt.
  if (providerError) {
    return redirectWithError(`Microsoft returned an error: ${providerError}`);
  }
  if (!code || !validateState(state, cookieState)) {
    return redirectWithError(
      "Invalid or expired connection attempt. Please try again.",
    );
  }

  const supabase = await getSupabaseServerClient();
  let membership;
  try {
    membership = await getCurrentMembership(supabase);
  } catch {
    return NextResponse.redirect(new URL("/login", appBaseUrl));
  }

  const clientEnv = getClientEnv();
  const serviceRoleClient = createSupabaseServiceRoleClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );

  try {
    await completeMicrosoftConnection(supabase, serviceRoleClient, {
      organizationId: membership.organizationId,
      membershipId: membership.membershipId,
      actorUserId: membership.userId,
      code,
      redirectUri: `${appBaseUrl}/api/integrations/microsoft/callback`,
      webhookUrl: `${getWebhookBaseUrl()}/api/webhooks/microsoft/calendar`,
      microsoftEnv: toMicrosoftEnv(getMicrosoftEnv()),
      encryptionKey: getEncryptionKey(),
    });
  } catch (error) {
    console.error("Microsoft connection failed", error);
    return redirectWithError(
      "Could not complete the Microsoft connection. Please try again.",
    );
  }

  const response = NextResponse.redirect(
    new URL("/integrations?microsoft_connected=1", appBaseUrl),
  );
  response.cookies.delete("ms_oauth_state");
  return response;
}
