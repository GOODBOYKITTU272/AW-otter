import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./types";

/** Safe to call from client components — uses only the public anon key. */
export function createSupabaseBrowserClient(url: string, anonKey: string) {
  return createBrowserClient<Database>(url, anonKey);
}
