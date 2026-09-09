import { cookies } from "next/headers";
import { createSupabaseServerClient } from "@applywizz/database/server";
import { getClientEnv } from "@/env/client";

/** Request-scoped, RLS-respecting client for Server Components / Route Handlers. */
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();
  const env = getClientEnv();

  return createSupabaseServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't set cookies during render — fine, because
          // proxy.ts (Next.js 16's renamed middleware convention) refreshes
          // the session on every request instead.
        }
      },
    },
  );
}
