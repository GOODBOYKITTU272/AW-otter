function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Client-safe configuration. Only NEXT_PUBLIC_ variables belong here —
 * this module is safe to import from browser code.
 */
export function getClientEnv() {
  return {
    NEXT_PUBLIC_SUPABASE_URL: required(
      "NEXT_PUBLIC_SUPABASE_URL",
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    ),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: required(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ),
  } as const;
}

export type ClientEnv = ReturnType<typeof getClientEnv>;
