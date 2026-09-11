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

/** Adapts getVexaEnv()'s env-var-named shape to @applywizz/meeting-bots' VexaEnv. */
export function toVexaEnv(env: ReturnType<typeof getVexaEnv>) {
  return {
    baseUrl: env.VEXA_BASE_URL,
    apiKey: env.VEXA_API_KEY,
  } as const;
}

export function getOpenAiEnv() {
  return {
    OPENAI_API_KEY: required("OPENAI_API_KEY", process.env.OPENAI_API_KEY),
  } as const;
}

/**
 * M8's temporary STT/normalization provider (locked architecture: "not a
 * permanent architectural dependency" — see packages/transcription). The
 * key stored here was exposed in visible process output during the M8
 * readiness investigation and is being treated as compromised; whatever
 * value is present here at any given time is whatever the operator has
 * most recently rotated it to — this getter has no way to know which.
 */
export function getOpenRouterEnv() {
  return {
    OPENROUTER_API_KEY: required(
      "OPENROUTER_API_KEY",
      process.env.OPENROUTER_API_KEY,
    ),
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

/**
 * The real ApplyWizz scheduler API (readiness report, 2026-09-08) — a
 * read-only scheduled-call context source, NOT the CRM integration
 * getCrmEnv() below is reserved for. Base URL only: the live endpoint is
 * currently unauthenticated (a documented, upstream production blocker —
 * see the readiness report's security findings), so there is no API key
 * to configure on Signal's side yet.
 */
export function getSchedulerEnv() {
  return {
    APPLYWIZZ_SCHEDULER_BASE_URL: required(
      "APPLYWIZZ_SCHEDULER_BASE_URL",
      process.env.APPLYWIZZ_SCHEDULER_BASE_URL,
    ),
  } as const;
}

/**
 * M10 amendment: the real customer-details/onboarding-baseline API
 * (apply-wizz.me) — a DIFFERENT service from getCrmEnv() below (which
 * remains reserved for a future full CRM adapter, still unused). The
 * example endpoint shown had no visible auth in its URL — API key is
 * left optional here rather than required, since it's genuinely unknown
 * whether this service needs one; @applywizz/crm's client only sends an
 * Authorization header when a key is actually configured.
 */
export function getCustomerDetailsEnv() {
  return {
    APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL: required(
      "APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL",
      process.env.APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL,
    ),
    APPLYWIZZ_CUSTOMER_DETAILS_API_KEY:
      process.env.APPLYWIZZ_CUSTOMER_DETAILS_API_KEY || null,
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

/**
 * M17B: the credential a scheduled-HTTP cron trigger presents as
 * `Authorization: Bearer <value>` — the shape Vercel Cron Jobs (and most
 * equivalent schedulers) send natively, which cannot carry a custom
 * `x-internal-queue-secret` header. A SEPARATE secret from
 * INTERNAL_QUEUE_SECRET on purpose: the scheduler's own credential and the
 * "call this route directly" credential should be independently
 * rotatable — compromising one shouldn't require rotating both.
 * Deliberately not required() — a deployment that isn't using a
 * GET/Authorization-based scheduler (e.g. local dev, CI, or a scheduler
 * that can send custom headers and just uses INTERNAL_QUEUE_SECRET
 * directly) never needs to set this at all; see
 * lib/internal-route-auth.ts, which only calls this if a Bearer token was
 * actually presented.
 */
export function getCronSecret(): string {
  return required("CRON_SECRET", process.env.CRON_SECRET);
}

export function getLogLevel(): string {
  return process.env.LOG_LEVEL ?? "info";
}

export function getAzureMaiEnv() {
  const endpoint = process.env.AZURE_MAI_ENDPOINT;
  const key = process.env.AZURE_MAI_KEY;
  const region = process.env.AZURE_MAI_REGION;
  return {
    AZURE_MAI_ENDPOINT: endpoint,
    AZURE_MAI_KEY: key,
    AZURE_MAI_REGION: region,
    isConfigured: Boolean(endpoint && key),
  } as const;
}

export function getTranscriptionConfigEnv() {
  const primaryProvider =
    (process.env.TRANSCRIPTION_PRIMARY_PROVIDER as "azure-mai" | "openrouter" | undefined) ??
    "openrouter";
  return {
    TRANSCRIPTION_PRIMARY_PROVIDER: primaryProvider,
  } as const;
}
