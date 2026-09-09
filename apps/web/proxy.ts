import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@applywizz/database/server";
import { getClientEnv } from "@/env/client";

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

  await supabase.auth.getUser();

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
