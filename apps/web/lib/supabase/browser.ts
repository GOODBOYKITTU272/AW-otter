import { createSupabaseBrowserClient } from "@applywizz/database/browser";
import { getClientEnv } from "@/env/client";

let client: ReturnType<typeof createSupabaseBrowserClient> | undefined;

/** One shared browser client per page load — safe to call from any client component. */
export function getSupabaseBrowserClient() {
  if (!client) {
    const env = getClientEnv();
    client = createSupabaseBrowserClient(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  }
  return client;
}
