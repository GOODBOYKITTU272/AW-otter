if (typeof window !== "undefined") {
  throw new Error(
    "env/server.ts was imported into browser code. Server-only secrets must never reach the client bundle.",
  );
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Server-only configuration. Never import this from a client component —
 * the guard above throws immediately if it's ever executed in a browser.
 */
export function getServerEnv() {
  return {
    SUPABASE_SERVICE_ROLE_KEY: required(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    MICROSOFT_CLIENT_ID: required(
      "MICROSOFT_CLIENT_ID",
      process.env.MICROSOFT_CLIENT_ID,
    ),
    MICROSOFT_CLIENT_SECRET: required(
      "MICROSOFT_CLIENT_SECRET",
      process.env.MICROSOFT_CLIENT_SECRET,
    ),
    MICROSOFT_TENANT_ID: required(
      "MICROSOFT_TENANT_ID",
      process.env.MICROSOFT_TENANT_ID,
    ),
    MICROSOFT_WEBHOOK_CLIENT_STATE: required(
      "MICROSOFT_WEBHOOK_CLIENT_STATE",
      process.env.MICROSOFT_WEBHOOK_CLIENT_STATE,
    ),
    VEXA_BASE_URL: required("VEXA_BASE_URL", process.env.VEXA_BASE_URL),
    VEXA_API_KEY: required("VEXA_API_KEY", process.env.VEXA_API_KEY),
    OPENAI_API_KEY: required("OPENAI_API_KEY", process.env.OPENAI_API_KEY),
    EMAIL_PROVIDER_API_KEY: required(
      "EMAIL_PROVIDER_API_KEY",
      process.env.EMAIL_PROVIDER_API_KEY,
    ),
    EMAIL_FROM_ADDRESS: required(
      "EMAIL_FROM_ADDRESS",
      process.env.EMAIL_FROM_ADDRESS,
    ),
    APPLYWIZZ_CRM_BASE_URL: required(
      "APPLYWIZZ_CRM_BASE_URL",
      process.env.APPLYWIZZ_CRM_BASE_URL,
    ),
    APPLYWIZZ_CRM_API_KEY: required(
      "APPLYWIZZ_CRM_API_KEY",
      process.env.APPLYWIZZ_CRM_API_KEY,
    ),
    APP_BASE_URL: required("APP_BASE_URL", process.env.APP_BASE_URL),
    WEBHOOK_BASE_URL: required(
      "WEBHOOK_BASE_URL",
      process.env.WEBHOOK_BASE_URL,
    ),
    ENCRYPTION_KEY: required("ENCRYPTION_KEY", process.env.ENCRYPTION_KEY),
    LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  } as const;
}

export type ServerEnv = ReturnType<typeof getServerEnv>;
