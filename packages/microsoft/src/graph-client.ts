import {
  GRAPH_BASE_URL,
  INITIAL_SYNC_WINDOW_DAYS,
  MAX_SUBSCRIPTION_MINUTES,
} from "./config";
import { normalizeGraphError } from "./errors";
import { normalizeCalendarEvent, type RawGraphEvent } from "./normalize";
import type { GraphSubscriptionDto, MicrosoftCalendarEvent } from "./types";

const EVENT_SELECT_FIELDS =
  "id,subject,start,end,organizer,attendees,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,lastModifiedDateTime,iCalUId,type,seriesMasterId,originalStart,isOrganizer";

async function graphRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const response = await fetchImpl(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      // Without this, Graph event ids can change on move/copy — the exact
      // scenario M4's canonical-meeting matching (organization_id, provider,
      // external_event_id) depends on being stable. Harmless on endpoints
      // that don't recognize it (subscriptions).
      Prefer: 'IdType="ImmutableId"',
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw normalizeGraphError(
      response.status,
      body,
      response.headers.get("retry-after"),
    );
  }
  return body as T;
}

/**
 * Shared implementation only — `basePath` is required and always caller-
 * supplied ("me" for a delegated token, "users/{encodedUPN}" for an
 * app-only token). Never exported directly: the public functions below are
 * separate, distinctly-named functions per mailbox-scope, specifically so
 * an app-only (tenant-wide) code path can never accidentally default to
 * "/me" the way an optional parameter could if forgotten.
 */
async function calendarViewFor(
  basePath: string,
  accessToken: string,
  fetchImpl: typeof fetch,
  windowDays: number,
): Promise<MicrosoftCalendarEvent[]> {
  const now = new Date();
  const end = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    startDateTime: now.toISOString(),
    endDateTime: end.toISOString(),
    $select: EVENT_SELECT_FIELDS,
    $orderby: "start/dateTime",
    $top: "100",
  });

  const result = await graphRequest<{ value: RawGraphEvent[] }>(
    `/${basePath}/calendarView?${params.toString()}`,
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
  return (result.value ?? []).map(normalizeCalendarEvent);
}

async function eventFor(
  basePath: string,
  accessToken: string,
  externalEventId: string,
  fetchImpl: typeof fetch,
): Promise<MicrosoftCalendarEvent | null> {
  const response = await fetchImpl(
    `${GRAPH_BASE_URL}/${basePath}/events/${encodeURIComponent(externalEventId)}?$select=${EVENT_SELECT_FIELDS}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'IdType="ImmutableId"',
      },
    },
  );
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw normalizeGraphError(response.status, body, response.headers.get("retry-after"));
  }
  return normalizeCalendarEvent(body as RawGraphEvent);
}

/** Bounded read: now -> now + windowDays (default 30, per the M3 brief). Delegated token, the signed-in user's own calendar. */
export async function listUpcomingEvents(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  windowDays: number = INITIAL_SYNC_WINDOW_DAYS,
): Promise<MicrosoftCalendarEvent[]> {
  return calendarViewFor("me", accessToken, fetchImpl, windowDays);
}

/**
 * Fetches a single event by id — used by the M4 queue processor to get the
 * current state of an event a webhook notification pointed at (Graph's
 * change notifications carry only an id, not the resource body). Returns
 * null on 404 (the event was deleted, or a "deleted" notification arrived
 * — either way there's nothing further to fetch). Delegated token.
 */
export async function getCalendarEvent(
  accessToken: string,
  externalEventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftCalendarEvent | null> {
  return eventFor("me", accessToken, externalEventId, fetchImpl);
}

/**
 * App-only (client_credentials) equivalent of listUpcomingEvents — reads a
 * SPECIFIC employee's calendar by UPN/work email using an app-only token.
 * `userPrincipalName` is required (not optional) so this can never be
 * confused with the delegated, current-user-only listUpcomingEvents.
 */
export async function listUpcomingEventsForUser(
  accessToken: string,
  userPrincipalName: string,
  fetchImpl: typeof fetch = fetch,
  windowDays: number = INITIAL_SYNC_WINDOW_DAYS,
): Promise<MicrosoftCalendarEvent[]> {
  return calendarViewFor(`users/${encodeURIComponent(userPrincipalName)}`, accessToken, fetchImpl, windowDays);
}

/** App-only equivalent of getCalendarEvent, for a specific employee's mailbox. */
export async function getCalendarEventForUser(
  accessToken: string,
  userPrincipalName: string,
  externalEventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftCalendarEvent | null> {
  return eventFor(`users/${encodeURIComponent(userPrincipalName)}`, accessToken, externalEventId, fetchImpl);
}

interface RawGraphSubscription {
  id: string;
  resource: string;
  expirationDateTime: string;
}

export interface CreateSubscriptionInput {
  accessToken: string;
  notificationUrl: string;
  clientState: string;
  resource?: string;
  fetchImpl?: typeof fetch;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<GraphSubscriptionDto> {
  const resource = input.resource ?? "me/events";
  const expirationDateTime = new Date(
    Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000,
  ).toISOString();

  const result = await graphRequest<RawGraphSubscription>(
    "/subscriptions",
    input.accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl: input.notificationUrl,
        resource,
        expirationDateTime,
        clientState: input.clientState,
      }),
    },
    input.fetchImpl,
  );

  return {
    externalSubscriptionId: result.id,
    resource: result.resource,
    expiresAt: result.expirationDateTime,
  };
}

export async function renewSubscription(
  accessToken: string,
  externalSubscriptionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphSubscriptionDto> {
  const expirationDateTime = new Date(
    Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000,
  ).toISOString();

  const result = await graphRequest<RawGraphSubscription>(
    `/subscriptions/${externalSubscriptionId}`,
    accessToken,
    { method: "PATCH", body: JSON.stringify({ expirationDateTime }) },
    fetchImpl,
  );

  return {
    externalSubscriptionId: result.id,
    resource: result.resource,
    expiresAt: result.expirationDateTime,
  };
}

export async function deleteSubscription(
  accessToken: string,
  externalSubscriptionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${GRAPH_BASE_URL}/subscriptions/${externalSubscriptionId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({}));
    throw normalizeGraphError(
      response.status,
      body,
      response.headers.get("retry-after"),
    );
  }
}
