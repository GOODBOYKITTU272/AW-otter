import { NextResponse } from "next/server";
import {
  UnauthenticatedError,
  requireAuthenticatedUser,
} from "@applywizz/auth";
import { buildAuthorizationUrl, generateState } from "@applywizz/microsoft";
import { getAppBaseUrl, getMicrosoftEnv } from "@/env/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Any authenticated person can start connecting THEIR OWN Microsoft
// account — membership identity for the actual connection is resolved
// server-side in the callback (@applywizz/auth's getCurrentMembership),
// never taken from a client-supplied id.
export async function GET() {
  const supabase = await getSupabaseServerClient();
  const appBaseUrl = getAppBaseUrl();

  try {
    await requireAuthenticatedUser(supabase);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.redirect(new URL("/login", appBaseUrl));
    }
    throw error;
  }

  const env = getMicrosoftEnv();
  const state = generateState();
  const redirectUri = `${appBaseUrl}/api/integrations/microsoft/callback`;

  const authorizationUrl = buildAuthorizationUrl({
    tenantId: env.MICROSOFT_TENANT_ID,
    clientId: env.MICROSOFT_CLIENT_ID,
    redirectUri,
    state,
  });

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("ms_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
