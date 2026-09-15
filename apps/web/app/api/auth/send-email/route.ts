import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface SupabaseSendEmailHookPayload {
  user: {
    id?: string;
    email: string;
  };
  email_data: {
    token?: string;
    token_hash?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
  };
}

async function getNoreplyAccessToken(): Promise<string> {
  const tenantId = process.env.MICROSOFT_TENANT_ID || "dd60b066-1b78-4515-84fb-a565c251cb5a";
  const clientId = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
  const username = process.env.NOREPLY_EMAIL || "noreply@applywizz.ai";
  const password = process.env.NOREPLY_PASSWORD;

  if (!password) {
    throw new Error("NOREPLY_PASSWORD environment variable is required.");
  }

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: clientId,
      username,
      password,
      scope: "https://graph.microsoft.com/.default",
    }).toString(),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Failed to authenticate ${username} with Microsoft Identity: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export async function POST(request: Request) {
  try {
    // Secret verification for webhook security if configured
    const secret = process.env.SUPABASE_AUTH_HOOK_SECRET;
    if (secret) {
      const incomingSecret = request.headers.get("x-supabase-signature") || request.headers.get("authorization");
      if (incomingSecret !== secret && incomingSecret !== `Bearer ${secret}`) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const payload: SupabaseSendEmailHookPayload = await request.json();
    const { user, email_data } = payload;
    const recipient = user?.email;
    if (!recipient) {
      return NextResponse.json({ error: "Missing recipient email" }, { status: 400 });
    }

    const actionType = email_data?.email_action_type || "magiclink";
    const token = email_data?.token || "";
    const siteUrl = email_data?.site_url || "https://echo.applywizz.ai";
    const redirectTo = email_data?.redirect_to || `${siteUrl}/auth/callback`;

    let actionUrl = redirectTo;
    if (email_data?.token_hash) {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://kwnlcwpuvlphxlbykgqi.supabase.co";
      actionUrl = `${supabaseUrl}/auth/v1/verify?token=${email_data.token_hash}&type=${actionType}&redirect_to=${encodeURIComponent(redirectTo)}`;
    }

    let subject = "Your Sign-in Code for ApplyWizz Echo";
    let htmlContent = "";

    if (actionType === "invite") {
      subject = "You've been invited to ApplyWizz Echo";
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #E5E7EB; border-radius: 8px;">
          <h2 style="color: #111827; margin-top: 0;">Welcome to ApplyWizz Echo</h2>
          <p style="color: #374151;">You have been invited to join ApplyWizz Echo. Click the button below to accept your invitation and set up your account:</p>
          <div style="margin: 25px 0;">
            <a href="${actionUrl}" style="background-color: #2563EB; color: #ffffff; padding: 12px 24px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invitation</a>
          </div>
          <p style="color: #6B7280; font-size: 12px; margin-top: 30px;">This link expires in 24 hours. If you did not expect this invitation, please ignore this email.</p>
        </div>
      `;
    } else if (actionType === "recovery") {
      subject = "Reset your ApplyWizz Echo Password";
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #E5E7EB; border-radius: 8px;">
          <h2 style="color: #111827; margin-top: 0;">Reset Your Password</h2>
          <p style="color: #374151;">We received a request to reset your password for ApplyWizz Echo. Click the button below to proceed:</p>
          <div style="margin: 25px 0;">
            <a href="${actionUrl}" style="background-color: #2563EB; color: #ffffff; padding: 12px 24px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
          </div>
          <p style="color: #6B7280; font-size: 12px; margin-top: 30px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `;
    } else {
      // magiclink / signup / default
      subject = "Your Sign-in Code for ApplyWizz Echo";
      htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #E5E7EB; border-radius: 8px;">
          <h2 style="color: #111827; margin-top: 0;">Sign in to ApplyWizz Echo</h2>
          <p style="color: #374151;">Your 6-digit verification code is:</p>
          <div style="font-size: 36px; font-weight: bold; color: #2563EB; letter-spacing: 6px; margin: 20px 0; background-color: #F3F4F6; padding: 15px; border-radius: 6px; text-align: center;">
            ${token}
          </div>
          ${actionUrl ? `
          <p style="color: #374151; margin-top: 25px;">Or click the button below to sign in directly:</p>
          <div style="margin: 15px 0;">
            <a href="${actionUrl}" style="background-color: #2563EB; color: #ffffff; padding: 12px 24px; font-weight: bold; text-decoration: none; border-radius: 6px; display: inline-block;">Sign in to Echo</a>
          </div>` : ""}
          <p style="color: #6B7280; font-size: 12px; margin-top: 30px;">This code expires in 60 minutes. If you did not request this code, please ignore this email.</p>
        </div>
      `;
    }

    const accessToken = await getNoreplyAccessToken();

    const sendRes = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: "HTML",
            content: htmlContent,
          },
          toRecipients: [
            {
              emailAddress: {
                address: recipient,
              },
            },
          ],
        },
        saveToSentItems: "false",
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error("[AuthSendEmailHook] Microsoft Graph sendMail failed:", sendRes.status, errText);
      return NextResponse.json({ error: "Failed to send email via Microsoft Graph" }, { status: 500 });
    }

    console.log(`[AuthSendEmailHook] Successfully sent ${actionType} email to ${recipient} via Microsoft Graph`);
    return NextResponse.json({}, { status: 200 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[AuthSendEmailHook] Error processing email hook:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
