if (typeof globalThis !== "undefined" && "window" in globalThis) {
  throw new Error(
    "database/server.ts was imported into browser code. Server-only Supabase clients must never reach the client bundle.",
  );
}

import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/** Request-scoped, RLS-respecting client for server components/route handlers. */
export function createSupabaseServerClient(
  url: string,
  anonKey: string,
  cookies: CookieMethodsServer,
) {
  return createServerClient<Database>(url, anonKey, { cookies });
}

/**
 * Full-privilege client that bypasses RLS. Only for trusted, server-side
 * operational code (the bootstrap/seed scripts) — never per-request app code.
 */
export function createSupabaseServiceRoleClient(
  url: string,
  serviceRoleKey: string,
) {
  return createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
