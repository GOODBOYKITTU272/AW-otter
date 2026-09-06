import type { MicrosoftCalendarEvent } from "./types";

interface RawGraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

interface RawGraphAttendee {
  emailAddress?: RawGraphEmailAddress;
}

export interface RawGraphEvent {
  id?: string;
  subject?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  organizer?: { emailAddress?: RawGraphEmailAddress };
  attendees?: RawGraphAttendee[];
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string | null;
  onlineMeeting?: { joinUrl?: string | null };
  lastModifiedDateTime?: string;
}

export function extractJoinUrl(raw: RawGraphEvent): string | null {
  return raw.onlineMeeting?.joinUrl ?? null;
}

/** Teams-specific: Graph also reports Skype/other providers via the same flag. */
export function isTeamsEvent(
  event: Pick<
    MicrosoftCalendarEvent,
    "isOnlineMeeting" | "onlineMeetingProvider"
  >,
): boolean {
  return (
    event.isOnlineMeeting === true &&
    event.onlineMeetingProvider === "teamsForBusiness"
  );
}

export function normalizeCalendarEvent(
  raw: RawGraphEvent,
): MicrosoftCalendarEvent {
  return {
    externalEventId: raw.id ?? "",
    subject: raw.subject ?? "(no subject)",
    start: raw.start?.dateTime ?? "",
    end: raw.end?.dateTime ?? "",
    organizer: {
      name: raw.organizer?.emailAddress?.name ?? null,
      email: raw.organizer?.emailAddress?.address ?? null,
    },
    attendees: (raw.attendees ?? []).map((attendee) => ({
      name: attendee.emailAddress?.name ?? null,
      email: attendee.emailAddress?.address ?? null,
    })),
    isOnlineMeeting: raw.isOnlineMeeting ?? false,
    onlineMeetingProvider: raw.onlineMeetingProvider ?? null,
    joinUrl: extractJoinUrl(raw),
    lastModified: raw.lastModifiedDateTime ?? "",
  };
}
