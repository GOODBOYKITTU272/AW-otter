import { DEFAULT_TIMEOUT_MS } from "./config";
import {
  SchedulerApiError,
  SchedulerMalformedResponseError,
  SchedulerProviderMisuseError,
  SchedulerTimeoutError,
} from "./errors";
import type {
  ListCallsParams,
  RawSchedulerCall,
  RawSchedulerCallsResponse,
  SchedulerCall,
} from "./types";

export interface ListCallsResult {
  calls: SchedulerCall[];
  /** Rows the API returned that were missing a required identity field — skipped individually, never fabricated. */
  skippedInvalidRows: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A non-empty string that also parses as a real date/time. */
function isParseableDateString(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

/**
 * Codex post-implementation review (SHOULD-FIX): an optional field of the
 * wrong runtime type (e.g. a number where a string is expected) would
 * previously flow straight through via `?? null`, which only replaces
 * null/undefined — never a wrong-typed value. Coerces anything that isn't
 * a genuine non-empty string to null instead, so a malformed upstream
 * value degrades to "unknown" rather than corrupting a downstream write
 * or comparison.
 */
function optionalString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

/** Same idea as optionalString, but additionally requires the value to parse as a real date — this only ever feeds a timestamptz column or Date arithmetic. */
function optionalDateString(value: unknown): string | null {
  return isParseableDateString(value) ? value : null;
}

/**
 * Readiness investigation (2026-09-08) found the real endpoint returns its
 * ENTIRE unauthenticated dataset — every AM — when am_email is missing or
 * "ALL". This is the one place that exposure is permanently closed off on
 * Signal's side: a request that would trigger it is never sent.
 */
function assertScopedAmEmail(amEmail: string): string {
  const normalized = amEmail.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new SchedulerProviderMisuseError(
      "SchedulerCallProvider.listCalls requires a concrete am_email — it must never be empty.",
    );
  }
  if (normalized === "all") {
    throw new SchedulerProviderMisuseError(
      'SchedulerCallProvider.listCalls refuses am_email="ALL" — the upstream API treats it as a wildcard that returns every AM\'s data unauthenticated.',
    );
  }
  return normalized;
}

function normalizeRow(raw: RawSchedulerCall): SchedulerCall | null {
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.lead_id) ||
    !isNonEmptyString(raw.am_email) ||
    !isNonEmptyString(raw.type) ||
    !isNonEmptyString(raw.status) ||
    // scheduled_at is required AND must actually parse — it drives
    // Tier-3 schedule-match Date arithmetic and a timestamptz column;
    // a syntactically-present but garbage value is treated the same as
    // a missing one (skip the row), never allowed through as data.
    !isParseableDateString(raw.scheduled_at)
  ) {
    return null;
  }
  return {
    externalCallId: raw.id,
    leadId: raw.lead_id,
    clientName: optionalString(raw.client_name),
    clientEmail: optionalString(raw.client_email),
    amEmail: raw.am_email.trim().toLowerCase(),
    externalType: raw.type,
    scheduledAt: raw.scheduled_at,
    endsAt: optionalDateString(raw.ends_at),
    externalStatus: raw.status,
    teamsLink: optionalString(raw.teams_link),
    teamsEventId: optionalString(raw.teams_event_id),
    teamsOnlineMeetingId: optionalString(raw.teams_online_meeting_id),
    sourceCreatedAt: optionalDateString(raw.created_at),
    sourceUpdatedAt: optionalDateString(raw.updated_at),
  };
}

async function fetchOnce(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { method: "GET", signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SchedulerTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/scheduler/calls behind Signal's own provider abstraction — the
 * only place in the codebase that fetches from this endpoint (revised M7A
 * plan: "do not scatter fetch calls throughout domain logic"). Retries
 * exactly once, and only for a transient failure (network error, timeout,
 * or a 5xx) — never for a 4xx or a validation failure, since those won't
 * resolve on retry. Never logs the response body (may contain customer
 * PII) — errors carry only status codes/generic messages.
 */
export async function listCalls(
  baseUrl: string,
  params: ListCallsParams,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ListCallsResult> {
  const amEmail = assertScopedAmEmail(params.amEmail);

  const query = new URLSearchParams({ am_email: amEmail });
  if (params.type) query.set("type", params.type);
  if (params.status) query.set("status", params.status);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.leadId) query.set("lead_id", params.leadId);
  if (params.orderBy) query.set("order_by", params.orderBy);

  const url = `${baseUrl.replace(/\/+$/, "")}/api/scheduler/calls?${query.toString()}`;

  let response: Response;
  try {
    response = await fetchOnce(url, timeoutMs, fetchImpl);
  } catch (firstError) {
    const retriable =
      firstError instanceof SchedulerTimeoutError ||
      firstError instanceof TypeError;
    if (!retriable) throw firstError;
    response = await fetchOnce(url, timeoutMs, fetchImpl);
  }

  if (!response.ok) {
    if (response.status >= 500) {
      // One retry for a transient server error.
      const retryResponse = await fetchOnce(url, timeoutMs, fetchImpl);
      if (retryResponse.ok) {
        return parseBody(await retryResponse.json().catch(() => null));
      }
      throw new SchedulerApiError(
        retryResponse.status,
        `Scheduler API request failed with status ${retryResponse.status}.`,
      );
    }
    throw new SchedulerApiError(
      response.status,
      `Scheduler API request failed with status ${response.status}.`,
    );
  }

  const body = await response.json().catch(() => null);
  return parseBody(body);
}

function parseBody(body: unknown): ListCallsResult {
  if (
    body === null ||
    typeof body !== "object" ||
    (body as RawSchedulerCallsResponse).success !== true ||
    !Array.isArray((body as RawSchedulerCallsResponse).calls)
  ) {
    throw new SchedulerMalformedResponseError(
      'Scheduler API response did not match the expected {"success":true,"calls":[...]} envelope.',
    );
  }

  const rawCalls = (body as RawSchedulerCallsResponse).calls;
  const calls: SchedulerCall[] = [];
  let skippedInvalidRows = 0;
  for (const raw of rawCalls) {
    const normalized = normalizeRow(raw);
    if (normalized) calls.push(normalized);
    else skippedInvalidRows += 1;
  }

  return { calls, skippedInvalidRows };
}
