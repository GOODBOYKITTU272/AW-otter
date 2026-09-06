/**
 * Tenant model: SINGLE-TENANT (ApplyWizz's own Microsoft 365 tenant).
 *
 * MICROSOFT_TENANT_ID (env, TRD-locked) is used directly in the authority
 * URL rather than the multi-tenant `common`/`organizations` endpoints. This
 * matches the blueprint's "Initial deployment: internal ApplyWizz" —
 * employees sign in with their existing ApplyWizz work account, not an
 * arbitrary outside organization. Do not change this to `common` without
 * an explicit product decision to support external tenants.
 */
export function buildAuthority(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}`;
}

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * Minimum Graph scopes for M3. Each one is used for exactly one thing:
 * - openid, profile, email: identity claims in the ID token (who connected),
 *   without a separate Graph call or the broader `User.Read` permission.
 * - offline_access: a refresh token, so calendar sync can run in the
 *   background without asking the employee to sign in again every hour.
 * - Calendars.Read: read the employee's calendar and event metadata
 *   (including online-meeting fields) to detect Teams events. Read-only —
 *   M3 never creates, updates, or deletes calendar events.
 *
 * No Mail.*, Contacts.*, Files.*, or any *.Write scope. Do not add scopes
 * "just in case" — a new scope is a new consent screen and a new thing to
 * justify.
 */
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Calendars.Read",
] as const;

export function scopeString(): string {
  return MICROSOFT_SCOPES.join(" ");
}

/**
 * Graph's own cap for calendar/event-resource subscriptions is 4230
 * minutes (~70.5 hours) — not a number ApplyWizz chose. Renewal (not a
 * longer initial expiry) is how subscriptions stay alive past that.
 */
export const MAX_SUBSCRIPTION_MINUTES = 4230;

/** M3's bounded initial-read window: now → next 30 days, per the brief. */
export const INITIAL_SYNC_WINDOW_DAYS = 30;
