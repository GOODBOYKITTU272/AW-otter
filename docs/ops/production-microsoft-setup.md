# Production Microsoft / Entra Setup Requirements (M17A)

Every fact below was read directly from `packages/microsoft/src/config.ts`, `packages/microsoft/src/auth.ts`, `packages/microsoft/src/graph-client.ts`, and the actual OAuth/webhook/callback routes under `apps/web/app/api/integrations/microsoft/` and `apps/web/app/api/webhooks/microsoft/calendar/` — not assumed or copied from generic Graph documentation.

## Tenant model (locked, do not change without a product decision)

`packages/microsoft/src/config.ts:1-13`: **single-tenant**, ApplyWizz's own Microsoft 365 tenant only. `MICROSOFT_TENANT_ID` is used directly in the authority URL (`https://login.microsoftonline.com/{tenantId}`), not the multi-tenant `common`/`organizations` endpoints. The code comment is explicit: *"Do not change this to `common` without an explicit product decision to support external tenants."* This means:
- The production Entra app registration must be created **in ApplyWizz's own tenant**, not a separate multi-tenant-capable registration.
- Only ApplyWizz employees (accounts that exist in that tenant) can ever complete the OAuth connect flow — this is enforced by the authority URL itself, not just documentation.

## Required Graph permissions (delegated, minimal — do not add more)

`packages/microsoft/src/config.ts:31-37`, requested exactly as `MICROSOFT_SCOPES`:
- `openid`, `profile`, `email` — ID token identity claims only.
- `offline_access` — refresh token, so calendar sync doesn't require the employee to re-authenticate hourly.
- `Calendars.Read` — **read-only**. The code comment is explicit: *"M3 never creates, updates, or deletes calendar events... No Mail.*, Contacts.*, Files.*, or any *.Write scope."*

All five are **delegated permissions** (the signed-in employee consents for their own calendar), not application/app-only permissions. The production Entra app registration must request exactly these five scopes and no others — adding scopes "just in case" is explicitly against this codebase's own stated discipline.

## Admin consent requirement — genuinely tenant-policy-dependent, not something this repo can answer

The OAuth flow (`packages/microsoft/src/auth.ts:29-41`) is a standard per-user delegated authorization-code flow — no `prompt=admin_consent` parameter is sent, confirmed by reading `buildAuthorizationUrl` in full. Whether a given employee can complete this flow **without** a tenant admin first granting org-wide consent depends entirely on ApplyWizz's own Entra tenant policy ("Users can consent to apps accessing company data" — enabled or restricted). **This is not knowable from the codebase and must be confirmed with whoever administers ApplyWizz's Entra tenant before pilot go-live.** If user consent is restricted (common in security-conscious tenants), a tenant admin will need to grant admin consent once for the new app registration before any pilot AM can connect their calendar.

## Redirect URI

Built at runtime as `${APP_BASE_URL}/api/integrations/microsoft/callback` (`apps/web/app/api/integrations/microsoft/connect/route.ts:29`). The production Entra app registration's **Redirect URIs** list must contain the exact production value, e.g. `https://<production-domain>/api/integrations/microsoft/callback` — HTTPS required, must match exactly (Entra redirect URI matching is exact-string, not prefix/wildcard).

## Webhook URL

Built at runtime as `${WEBHOOK_BASE_URL}/api/webhooks/microsoft/calendar` (`apps/web/app/api/integrations/microsoft/callback/route.ts:64`, passed to `createSubscription` as `notificationUrl`). This is what Graph calls back to on every calendar change. Requirements, verified against the actual webhook handler (`apps/web/app/api/webhooks/microsoft/calendar/route.ts`):
- Must be **publicly reachable over HTTPS** — Graph cannot deliver to `localhost` or an unreachable address, so this genuinely cannot be tested until real deployment (M17B) exists.
- **Subscription validation handshake**: on subscription creation, Graph sends a `GET`/`POST` with a `validationToken` query param; the route already correctly echoes it back as `text/plain` (lines 20-26) — no change needed, already correct, just needs a reachable URL to prove it against.
- **Every notification's `clientState` is checked** via `validateState` (timing-safe compare, same utility used everywhere else in this codebase) against `MICROSOFT_WEBHOOK_CLIENT_STATE` before any processing happens — confirmed by reading the handler in full. A notification with a missing/mismatched `clientState` is silently skipped (`continue`), not processed and not logged as an error (correct — this is the expected shape of noise/forged traffic, not an incident).
- The handler does **no Graph calls of its own** — it only records that a notification arrived and hands the actual fetch off to the durable calendar-event queue (`processCalendarEventQueue`), confirmed by the file's own header comment. This means the webhook route itself is fast and lightweight regardless of hosting topology (§6 of `m17-plan.md`) — it is not the part of this system with a heavy per-request cost.

## Subscription callback requirements / expiration / renewal — the one real gap this checkpoint surfaces

`packages/microsoft/src/config.ts:43-48`: **`MAX_SUBSCRIPTION_MINUTES = 4230`** (~70.5 hours, roughly 2.9 days) — the code comment is explicit this is *"Graph's own cap for calendar/event-resource subscriptions... not a number ApplyWizz chose."* A subscription created today expires in under 3 days unless renewed.

`packages/microsoft/src/graph-client.ts` already implements `createSubscription`, `renewSubscription`, and (implied by the subscription-management surface) delete/cleanup — and `packages/domain/src/microsoft-connection.ts:314` already wraps renewal as `renewMicrosoftSubscription`. **Confirmed by grep: nothing in `apps/web/app/api/` or `workers/orchestrator/` ever calls `renewMicrosoftSubscription`.** This is coded but genuinely unscheduled — exactly the gap the M17A instructions called out by name ("The existing renewal function is coded but not scheduled. Do not leave that unresolved.").

**This is not resolved by M17A** (M17A is documentation/config-readiness only, per its own scope boundary — implementing a new scheduled route is M17B/M17C work, already planned for in `m17-plan.md` §6's table). What M17A does resolve: making the requirement explicit and precise (exact 4230-minute ceiling, exact unused function name and location) so M17B/C cannot silently miss it. **Recommendation carried into `m17-plan.md`: renewal must run at least once every 24 hours (comfortably inside the ~70.5-hour ceiling with wide margin for a missed tick or two), calling the existing `renewMicrosoftSubscription` per active connection.**

## Tenant/account assumptions

- The production Entra app registration assumes every pilot AM and Manager/Admin is a real user in ApplyWizz's own Microsoft 365 tenant (per the single-tenant model above) — no support for guest accounts or cross-tenant users exists in this flow.
- One Entra app registration serves the whole ApplyWizz organization (all pilot users connect through the same `MICROSOFT_CLIENT_ID`); there is no per-user or per-AM app registration.

## Do not reuse dev credentials

Per explicit instruction and consistent with `production-secrets-checklist.md`: the production Entra app registration must be a **separate registration**, not the same one (if any) used during development/testing, with its own `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET`. A fresh `MICROSOFT_WEBHOOK_CLIENT_STATE` value must also be generated for production (this is app-generated, not Entra-issued, but must not be shared across environments — see the secrets checklist's "MUST NOT be reused" list).

## Summary checklist for whoever provisions the Entra app registration

1. Create a new app registration in ApplyWizz's own Microsoft 365 tenant (not multi-tenant).
2. Configure delegated permissions: `openid`, `profile`, `email`, `offline_access`, `Calendars.Read` — exactly these five, nothing else.
3. Add redirect URI: `https://<production-domain>/api/integrations/microsoft/callback`.
4. Confirm with ApplyWizz's Entra/IT admin whether tenant-wide admin consent is required before pilot users can connect — grant it if so.
5. Generate a client secret; store as `MICROSOFT_CLIENT_SECRET` per `production-secrets-checklist.md` (never in this doc, never in source).
6. Confirm `WEBHOOK_BASE_URL` will be a real, stable, HTTPS-reachable production URL before attempting to create any subscription (this can only be smoke-tested after M17B deployment).
7. Before pilot go-live: confirm M17B/C has implemented and scheduled the subscription-renewal route (§6 of `m17-plan.md`), running at least daily.
