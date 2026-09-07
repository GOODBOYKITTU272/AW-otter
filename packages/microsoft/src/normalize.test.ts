import { describe, expect, it } from "vitest";
import {
  extractJoinUrl,
  isTeamsEvent,
  normalizeCalendarEvent,
  type RawGraphEvent,
} from "./normalize";

const teamsEvent: RawGraphEvent = {
  id: "evt-1",
  subject: "Progress Review",
  start: { dateTime: "2026-09-10T15:00:00Z" },
  end: { dateTime: "2026-09-10T15:30:00Z" },
  organizer: {
    emailAddress: { name: "Ada Admin", address: "ada@applywizz.test" },
  },
  attendees: [
    { emailAddress: { name: "Client", address: "client@example.com" } },
  ],
  isOnlineMeeting: true,
  onlineMeetingProvider: "teamsForBusiness",
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/abc" },
  lastModifiedDateTime: "2026-09-01T00:00:00Z",
  iCalUId: "ical-uid-1",
  type: "singleInstance",
  seriesMasterId: null,
  originalStart: null,
  isOrganizer: true,
};

const plainEvent: RawGraphEvent = {
  id: "evt-2",
  subject: "In-person coffee",
  start: { dateTime: "2026-09-11T10:00:00Z" },
  end: { dateTime: "2026-09-11T10:30:00Z" },
};

describe("normalizeCalendarEvent", () => {
  it("normalizes a full Teams event", () => {
    const event = normalizeCalendarEvent(teamsEvent);
    expect(event).toEqual({
      externalEventId: "evt-1",
      subject: "Progress Review",
      start: "2026-09-10T15:00:00Z",
      end: "2026-09-10T15:30:00Z",
      organizer: { name: "Ada Admin", email: "ada@applywizz.test" },
      attendees: [{ name: "Client", email: "client@example.com" }],
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/abc",
      lastModified: "2026-09-01T00:00:00Z",
      icalUId: "ical-uid-1",
      graphEventType: "singleInstance",
      seriesMasterId: null,
      originalStart: null,
      isOrganizer: true,
    });
  });

  it("fills in safe defaults for a minimal event", () => {
    const event = normalizeCalendarEvent(plainEvent);
    expect(event.isOnlineMeeting).toBe(false);
    expect(event.joinUrl).toBeNull();
    expect(event.attendees).toEqual([]);
    expect(event.organizer).toEqual({ name: null, email: null });
    expect(event.icalUId).toBe("");
    expect(event.graphEventType).toBeNull();
    expect(event.isOrganizer).toBe(false);
  });
});

describe("isTeamsEvent", () => {
  it("is true for a Teams-for-business online meeting", () => {
    expect(isTeamsEvent(normalizeCalendarEvent(teamsEvent))).toBe(true);
  });

  it("is false for a non-online event", () => {
    expect(isTeamsEvent(normalizeCalendarEvent(plainEvent))).toBe(false);
  });

  it("is false for a non-Teams online meeting provider", () => {
    expect(
      isTeamsEvent({
        isOnlineMeeting: true,
        onlineMeetingProvider: "skypeForBusiness",
      }),
    ).toBe(false);
  });
});

describe("extractJoinUrl", () => {
  it("extracts the join URL when present", () => {
    expect(extractJoinUrl(teamsEvent)).toBe(
      "https://teams.microsoft.com/l/meetup-join/abc",
    );
  });

  it("returns null when absent", () => {
    expect(extractJoinUrl(plainEvent)).toBeNull();
  });
});
