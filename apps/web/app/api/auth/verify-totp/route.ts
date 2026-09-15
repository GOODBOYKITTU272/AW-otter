import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@applywizz/database/server";
import { isAllowedEmailDomain } from "@applywizz/auth";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { email, code } = await request.json();
    const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const trimmedCode = typeof code === "string" ? code.trim() : "";

    if (!trimmedEmail || !isAllowedEmailDomain(trimmedEmail)) {
      return NextResponse.json(
        { error: "Only @applywizz.ai email addresses are permitted." },
        { status: 400 },
      );
    }

    if (!trimmedCode || trimmedCode.length !== 6) {
      return NextResponse.json(
        { error: "Please enter the complete 6-digit Authenticator code." },
        { status: 400 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      return NextResponse.json(
        { error: "Server configuration missing." },
        { status: 500 },
      );
    }

    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Silently generate admin token for user without dispatching email
    const { data: linkData, error: linkError } =
      await adminSupabase.auth.admin.generateLink({
        type: "magiclink",
        email: trimmedEmail,
      });

    if (linkError || !linkData.properties?.email_otp) {
      return NextResponse.json(
        { error: "Failed to initialize verification session." },
        { status: 400 },
      );
    }

    // 2. Prepare response and SSR cookie store bridge
    let redirectUrl = "/admin/overview";
    const responseCookies: { name: string; value: string; options: Record<string, unknown> }[] = [];

    const cookieStore = await cookies();
    const userClient = createSupabaseServerClient(supabaseUrl, anonKey, {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // Ignored
          }
          responseCookies.push({ name, value, options: options as Record<string, unknown> });
        }
      },
    });

    // 3. Establish AAL1 session using SSR client so cookies are properly tracked
    const { data: verifyData, error: verifyError } =
      await userClient.auth.verifyOtp({
        email: trimmedEmail,
        token: linkData.properties.email_otp,
        type: "magiclink",
      });

    if (verifyError || !verifyData.session) {
      return NextResponse.json(
        { error: "Failed to establish initial auth session." },
        { status: 400 },
      );
    }

    // 4. Find verified TOTP factor
    const { data: factors, error: mfaError } =
      await userClient.auth.mfa.listFactors();

    const totpFactor =
      factors?.totp?.find((f) => f.status === "verified") ||
      factors?.all?.find(
        (f) => f.factor_type === "totp" && f.status === "verified",
      );

    if (mfaError || !totpFactor) {
      return NextResponse.json(
        { error: "No verified Microsoft Authenticator found for this account." },
        { status: 400 },
      );
    }

    // 5. Challenge & verify user's Microsoft Authenticator code on SSR client
    const { data: mfaVerifyData, error: mfaVerifyError } =
      await userClient.auth.mfa.challengeAndVerify({
        factorId: totpFactor.id,
        code: trimmedCode,
      }).catch(async () => {
        const { data: challengeData, error: challengeError } =
          await userClient.auth.mfa.challenge({ factorId: totpFactor.id });
        if (challengeError || !challengeData) return { data: null, error: challengeError };
        return userClient.auth.mfa.verify({
          factorId: totpFactor.id,
          challengeId: challengeData.id,
          code: trimmedCode,
        });
      });

    if (mfaVerifyError || !mfaVerifyData) {
      return NextResponse.json(
        { error: "Invalid code. Please check Microsoft Authenticator and try again." },
        { status: 400 },
      );
    }

    // 6. Query user active membership & role home route
    const userId = mfaVerifyData.user?.id || verifyData.user?.id;
    if (userId) {
      const { data: membership } = await adminSupabase
        .from("organization_memberships")
        .select("role_id")
        .eq("user_id", userId)
        .eq("status", "active")
        .maybeSingle();

      if (membership?.role_id) {
        const { data: role } = await adminSupabase
          .from("roles")
          .select("key")
          .eq("id", membership.role_id)
          .maybeSingle();

        const roleKey = role?.key;
        if (roleKey && isSystemRoleKey(roleKey)) {
          redirectUrl = ROLE_HOME_ROUTE[roleKey];
        }
      }
    }

    // 7. Construct final response with SSR session cookies attached
    const response = NextResponse.json({
      success: true,
      redirectUrl,
    });

    for (const { name, value, options } of responseCookies) {
      response.cookies.set(name, value, options);
    }

    return response;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
