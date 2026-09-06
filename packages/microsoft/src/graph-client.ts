import {
  GRAPH_BASE_URL,
  INITIAL_SYNC_WINDOW_DAYS,
  MAX_SUBSCRIPTION_MINUTES,
} from "./config";
import { normalizeGraphError } from "./errors";
import { normalizeCalendarEvent, type RawGraphEvent } from "./normalize";
import type { GraphSubscriptionDto, MicrosoftCalendarEvent } from "./types";

const EVENT_SELECT_FIELDS =
  "id,subject,start,end,organizer,attendees,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,lastModifiedDateTime";

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

/** Bounded read: now -> now + windowDays (default 30, per the M3 brief). */
export async function listUpcomingEvents(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  windowDays: number = INITIAL_SYNC_WINDOW_DAYS,
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
    `/me/calendarView?${params.toString()}`,
    accessToken,
    { method: "GET" },
    fetchImpl,
  );
  return (result.value ?? []).map(normalizeCalendarEvent);
}

/**
 * Fetches a single event by id — used by the M4 queue processor to get the
 * current state of an event a webhook notification pointed at (Graph's
 * change notifications carry only an id, not the resource body). Returns
 * null on 404 (the event was deleted, or a "deleted" notification arrived
 * — either way there's nothing further to fetch).
 */
export async function getCalendarEvent(
  accessToken: string,
  externalEventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<MicrosoftCalendarEvent | null> {
  const response = await fetchImpl(
    `${GRAPH_BASE_URL}/me/events/${encodeURIComponent(externalEventId)}?$select=${EVENT_SELECT_FIELDS}`,
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
