# Production Secrets / Configuration Checklist (M17A)

**No secret values appear in this document, in source code, or in logs — every row below names a variable and its purpose only.** Verified structurally, not just by convention: `apps/web/env/server.ts:1-5` throws at import time if pulled into browser code; `apps/web/env/client.ts` exports exactly two `NEXT_PUBLIC_*` values and nothing else (read in full, not sampled).

Every row was read directly from `apps/web/env/server.ts` / `apps/web/env/client.ts` on `main` @ `948b7c7413e01bf183e5179ecd09e5fe1afc2678` — nothing here is inferred or guessed.

## Server-only secrets

| Variable | Required? | Provider | Purpose | Consumed where | New production credential required? |
|---|---|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | required | Supabase | full-privilege DB access for every `/api/internal/*` route and the bot worker | `env/server.ts:getSupabaseServiceRoleKey`, every internal route, `workers/orchestrator/bot-worker.mjs` | **Yes — new value from the new production Supabase project. Never reuse the local/dev key.** |
| `MICROSOFT_CLIENT_ID` | required | Microsoft Entra | OAuth app identity | `env/server.ts:getMicrosoftEnv`, `packages/microsoft` | **Yes — new production Entra app registration.** See `production-microsoft-setup.md`. |
| `MICROSOFT_CLIENT_SECRET` | required | Microsoft Entra | OAuth app secret | same | **Yes**, same registration. |
| `MICROSOFT_TENANT_ID` | required | Microsoft Entra | single-tenant authority (ApplyWizz's own tenant only — see `packages/microsoft/src/config.ts:1-13`, deliberately not multi-tenant `common`) | same | Yes if the production Entra app lives in a different tenant than whatever was used for dev/testing — confirm which tenant ApplyWizz's real employees are in. |
| `MICROSOFT_WEBHOOK_CLIENT_STATE` | required | n/a (app-generated) | shared secret Graph echoes back on every webhook call, checked by the webhook route to reject forged notifications | `env/server.ts:getMicrosoftEnv`, `apps/web/app/api/webhooks/microsoft/calendar/route.ts` | **Yes — generate a fresh high-entropy value for production, never reuse dev's.** |
| `ENCRYPTION_KEY` | required | n/a (app-generated) | at-rest encryption for stored Microsoft OAuth tokens | `env/server.ts:getEncryptionKey`, `packages/microsoft` | **Yes — fresh key. A shared/reused key across environments would mean a dev-environment compromise could decrypt production tokens.** |
| `APP_BASE_URL` | required | n/a | the app's own production URL, used for constructing links (e.g. recap email "View in Signal" link, once M17D exists) | `env/server.ts:getAppBaseUrl` | N/A — not a secret, but must be the real production domain, not `localhost`. |
| `WEBHOOK_BASE_URL` | required | n/a | the URL Microsoft Graph calls back to | `env/server.ts:getWebhookBaseUrl` | N/A — not a secret, must be real + HTTPS-reachable. |
| `VEXA_BASE_URL` | required | Vexa | Vexa API base URL | `env/server.ts:getVexaEnv`, `packages/meeting-bots` | Confirm whether dev/prod use the same Vexa base URL or separate sandbox/prod endpoints — Vexa-account-specific, verify with whoever owns that account. |
| `VEXA_API_KEY` | required | Vexa | Vexa API auth | same | **Flag for real verification in M17C — do not assume the current key supports joining real external Teams meetings; may be a dev/sandbox-tier key.** |
| `OPENAI_API_KEY` | required (by the getter) | OpenAI | reserved — `getOpenAiEnv()` exists but no currently-wired code path was found calling it in this repo (grep for its usages found only the getter definition) | `env/server.ts:getOpenAiEnv` | Low priority — confirm whether anything actually needs this before provisioning a production key just for an unused getter. |
| `OPENROUTER_API_KEY` | required | OpenRouter | M8's transcription/normalization + meeting-intelligence provider | `env/server.ts:getOpenRouterEnv`, `packages/transcription`, meeting-intelligence | **Yes, mandatorily. The getter's own code comment states the current key value was exposed in visible process output during an earlier investigation and must be treated as compromised. A fresh key is required regardless of whatever value dev is currently using — do not carry it forward under any circumstance.** |
| `EMAIL_PROVIDER_API_KEY` | required (by the getter) | TBD (§7 of `m17-plan.md` recommends Resend as a default, not yet confirmed) | internal post-meeting recap email (M17D, not yet built) | `env/server.ts:getEmailEnv` — **currently unused anywhere in the codebase**, confirmed by grep | Yes, once the concrete provider is chosen and M17D is built — not needed for M17A itself. |
| `EMAIL_FROM_ADDRESS` | required (by the getter) | n/a | the "from" address recap emails will use | same | Needs a real ApplyWizz-controlled sending address/domain once M17D is built. |
| `APPLYWIZZ_SCHEDULER_BASE_URL` | required | ApplyWizz's own scheduler API | source of scheduled-call context | `env/server.ts:getSchedulerEnv` | Base URL only, no API key — **the getter's own comment states the real live endpoint is currently unauthenticated on the upstream side, a documented existing production blocker this repo cannot fix.** Flag to whoever owns that service before pilot go-live. |
| `APPLYWIZZ_CUSTOMER_DETAILS_BASE_URL` | required | apply-wizz.me | customer/onboarding baseline data | `env/server.ts:getCustomerDetailsEnv` | Confirm production base URL. |
| `APPLYWIZZ_CUSTOMER_DETAILS_API_KEY` | **optional** (`|| null`) | apply-wizz.me | same | same | The getter's own comment: genuinely unknown whether this service requires auth at all; the client only sends an `Authorization` header when a value is actually configured. Not a gap — a deliberate, documented "don't invent a requirement that may not exist" choice. |
| `APPLYWIZZ_CRM_BASE_URL` | required | ApplyWizz CRM (reserved adapter) | `env/server.ts:getCrmEnv` | Confirm whether Phase 1 pilot actually needs this at all — `packages/crm` is described as a reserved/future adapter; if unused for Phase 1, this can stay whatever placeholder value keeps `required()` from throwing, or the getter's call site should be confirmed not to run in the pilot's actual code paths. |
| `APPLYWIZZ_CRM_API_KEY` | required | same | same | same | same caveat |
| `INTERNAL_QUEUE_SECRET` | required | n/a (app-generated) | the shared secret every `/api/internal/*` route checks via `validateState` (timing-safe compare, `packages/microsoft/src/auth.ts:11-20`) — gates every scheduled job | `env/server.ts:getInternalQueueSecret`, every internal route | **Yes — fresh, high-entropy, production-only value. This is what protects every scheduled job (§6 of `m17-plan.md`) from being triggerable by anyone who doesn't hold it — treat with the same care as a service-role key.** |
| `LOG_LEVEL` | optional, defaults to `"info"` | n/a | log verbosity | `env/server.ts:getLogLevel` | Not a secret, safe default, no action needed. |

## Browser-safe (client bundle)

| Variable | Required? | Purpose | Consumed where |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | required | Supabase project URL — safe to expose, it's a public endpoint | `env/client.ts:getClientEnv` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | required | Supabase anon key — safe to expose by Supabase's own design (RLS is the actual boundary, not this key's secrecy) | same |

**Confirmed via full read of `apps/web/env/client.ts`: these are the only two exported values.** No server secret is reachable through `NEXT_PUBLIC_*` anywhere in this codebase.

## Credentials that MUST NOT be reused from dev/local

1. `OPENROUTER_API_KEY` — documented-compromised, mandatory rotation, no exceptions.
2. `SUPABASE_SERVICE_ROLE_KEY` — new project, inherently a new key, but calling out explicitly: never point production's service-role key at the local/dev project or vice versa.
3. `ENCRYPTION_KEY` — a shared key would mean a dev compromise decrypts production Microsoft tokens.
4. `INTERNAL_QUEUE_SECRET` — a shared value would mean anyone who ever had dev access could trigger production job endpoints.
5. `MICROSOFT_WEBHOOK_CLIENT_STATE` — a shared value weakens the webhook forgery check across environments.
6. `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` — separate Entra app registration entirely (see `production-microsoft-setup.md`), not just a new secret on the same dev app registration.

## What does NOT need a new value

- `LOG_LEVEL` — safe default, environment-appropriate value can be set per environment without any secrecy concern.
- `APPLYWIZZ_CUSTOMER_DETAILS_API_KEY` — optional by design, no action forced.
