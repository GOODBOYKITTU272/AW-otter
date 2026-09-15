import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAllowedEmailDomain } from "@applywizz/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { email } = await request.json();
    const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!trimmedEmail || !isAllowedEmailDomain(trimmedEmail)) {
      return NextResponse.json(
        { error: "Only @applywizz.ai email addresses are permitted." },
        { status: 400 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Server configuration missing." },
        { status: 500 },
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Look up user by email
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();

    if (listError || !usersData?.users) {
      return NextResponse.json(
        { registered: false, hasVerifiedTotp: false },
        { status: 200 },
      );
    }

    const user = usersData.users.find(
      (u) => u.email?.toLowerCase() === trimmedEmail,
    );

    if (!user) {
      return NextResponse.json(
        { registered: false, hasVerifiedTotp: false },
        { status: 200 },
      );
    }

    // Check MFA factors for this user
    const { data: mfaData } = await supabase.auth.admin.mfa.listFactors({
      userId: user.id,
    });

    const hasVerifiedTotp = Boolean(
      mfaData?.factors?.some(
        (f) => f.factor_type === "totp" && f.status === "verified",
      ),
    );

    return NextResponse.json({
      registered: true,
      hasVerifiedTotp,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
