import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@applywizz/database/server";
import { getClientEnv } from "@/env/client";
import { ROLE_HOME_ROUTE, isSystemRoleKey } from "@applywizz/domain";

// Required by @supabase/ssr on Next.js App Router: Server Components can't
// write cookies during render, so the refreshed session token has to be
// re-issued here, on every request, before it reaches a Server Component.
export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  const env = getClientEnv();

  const supabase = createSupabaseServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  if (user && (pathname === "/login" || pathname === "/")) {
    const { data: membership } = await supabase
      .from("organization_memberships")
      .select("role_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (membership) {
      const { data: role } = await supabase
        .from("roles")
        .select("key")
        .eq("id", membership.role_id)
        .maybeSingle();

      const roleKey = role?.key;
      if (roleKey && isSystemRoleKey(roleKey)) {
        return NextResponse.redirect(
          new URL(ROLE_HOME_ROUTE[roleKey], request.url),
          {
            headers: response.headers,
          },
        );
      }
    }
  }

  return response;
}

export const config = {
  // M17B: also exclude /api/webhooks, /api/internal, and /api/health —
  // none of these ever carries a browser session (webhooks are
  // server-to-server from Microsoft; internal routes are secret-header/
  // scheduler-gated; health is a public liveness probe). Running the
  // session-refresh call against them was harmless (empty cookies -> "no
  // user", cheap no-op) but wasted, and these routes are about to be hit
  // very frequently once M17B's scheduling + uptime monitoring are wired up.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/internal|api/health).*)",
  ],
};
