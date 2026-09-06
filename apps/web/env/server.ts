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
 * Per-concern getters rather than one getServerEnv() blob: a route that
 * only needs Microsoft credentials shouldn't fail because Vexa/OpenAI/
 * Email/CRM vars (unrelated future milestones) aren't set yet.
 */

export function getSupabaseServiceRoleKey(): string {
  return required(
    "SUPABASE_SERVICE_ROLE_KEY",
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

export function getMicrosoftEnv() {
  return {
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
  } as const;
}

/** Adapts getMicrosoftEnv()'s env-var-named shape to @applywizz/microsoft's MicrosoftEnv. */
export function toMicrosoftEnv(env: ReturnType<typeof getMicrosoftEnv>) {
  return {
    tenantId: env.MICROSOFT_TENANT_ID,
    clientId: env.MICROSOFT_CLIENT_ID,
    clientSecret: env.MICROSOFT_CLIENT_SECRET,
    webhookClientState: env.MICROSOFT_WEBHOOK_CLIENT_STATE,
  } as const;
}

export function getEncryptionKey(): string {
  return required("ENCRYPTION_KEY", process.env.ENCRYPTION_KEY);
}

export function getAppBaseUrl(): string {
  return required("APP_BASE_URL", process.env.APP_BASE_URL);
}

export function getWebhookBaseUrl(): string {
  return required("WEBHOOK_BASE_URL", process.env.WEBHOOK_BASE_URL);
}

export function getVexaEnv() {
  return {
    VEXA_BASE_URL: required("VEXA_BASE_URL", process.env.VEXA_BASE_URL),
    VEXA_API_KEY: required("VEXA_API_KEY", process.env.VEXA_API_KEY),
  } as const;
}

export function getOpenAiEnv() {
  return {
    OPENAI_API_KEY: required("OPENAI_API_KEY", process.env.OPENAI_API_KEY),
  } as const;
}

export function getEmailEnv() {
  return {
    EMAIL_PROVIDER_API_KEY: required(
      "EMAIL_PROVIDER_API_KEY",
      process.env.EMAIL_PROVIDER_API_KEY,
    ),
    EMAIL_FROM_ADDRESS: required(
      "EMAIL_FROM_ADDRESS",
      process.env.EMAIL_FROM_ADDRESS,
    ),
  } as const;
}

export function getCrmEnv() {
  return {
    APPLYWIZZ_CRM_BASE_URL: required(
      "APPLYWIZZ_CRM_BASE_URL",
      process.env.APPLYWIZZ_CRM_BASE_URL,
    ),
    APPLYWIZZ_CRM_API_KEY: required(
      "APPLYWIZZ_CRM_API_KEY",
      process.env.APPLYWIZZ_CRM_API_KEY,
    ),
  } as const;
}

/** Shared secret gating the internal queue-processing route — never exposed to the browser, never derivable by an authenticated app user. */
export function getInternalQueueSecret(): string {
  return required("INTERNAL_QUEUE_SECRET", process.env.INTERNAL_QUEUE_SECRET);
}

export function getLogLevel(): string {
  return process.env.LOG_LEVEL ?? "info";
}
