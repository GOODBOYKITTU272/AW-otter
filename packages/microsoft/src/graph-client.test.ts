import { describe, expect, it } from "vitest";
import {
  createSubscription,
  deleteSubscription,
  getCalendarEvent,
  getCalendarEventForUser,
  listUpcomingEvents,
  listUpcomingEventsForUser,
  renewSubscription,
  patchOnlineMeetingLobbyBypass,
  addEchoAttendeeToOnlineMeeting,
} from "./graph-client";
import { GraphApiError } from "./errors";
import { MAX_SUBSCRIPTION_MINUTES } from "./config";

function fakeFetch(status: number, body: unknown) {
  // The Fetch spec forbids a body on a 204 response.
  const hasBody = status !== 204;
  return async () =>
    new Response(hasBody ? JSON.stringify(body) : null, {
      status,
      headers: hasBody ? { "Content-Type": "application/json" } : {},
    });
}

describe("listUpcomingEvents", () => {
  it("normalizes the returned event list", async () => {
    const events = await listUpcomingEvents(
      "at",
      fakeFetch(200, {
        value: [
          {
            id: "e1",
            subject: "Sync",
            start: { dateTime: "x" },
            end: { dateTime: "y" },
          },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.externalEventId).toBe("e1");
  });

  it("returns an empty array when Graph returns no events", async () => {
    const events = await listUpcomingEvents(
      "at",
      fakeFetch(200, { value: [] }),
    );
    expect(events).toEqual([]);
  });

  it("throws a typed error on a Graph failure", async () => {
    await expect(
      listUpcomingEvents(
        "at",
        fakeFetch(500, { error: { code: "ServiceError" } }),
      ),
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("listUpcomingEventsForUser / getCalendarEventForUser", () => {
  function capturingFetch(status: number, body: unknown) {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      calls.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { fetchImpl, calls };
  }

  it("targets /users/{upn}/calendarView, never /me", async () => {
    const { fetchImpl, calls } = capturingFetch(200, { value: [] });
    await listUpcomingEventsForUser("at", "am1@applywizz.test", fetchImpl);
    expect(calls[0]).toContain("/users/am1%40applywizz.test/calendarView");
    expect(calls[0]).not.toContain("/me/");
  });

  it("targets /users/{upn}/events/{id}, never /me", async () => {
    const { fetchImpl, calls } = capturingFetch(200, {
      id: "evt-1",
      subject: "Sync",
      start: { dateTime: "x" },
      end: { dateTime: "y" },
    });
    const event = await getCalendarEventForUser("at", "am1@applywizz.test", "evt-1", fetchImpl);
    expect(calls[0]).toContain("/users/am1%40applywizz.test/events/evt-1");
    expect(calls[0]).not.toContain("/me/");
    expect(event?.externalEventId).toBe("evt-1");
  });

  it("returns null on 404, same as the delegated version", async () => {
    const { fetchImpl } = capturingFetch(404, {});
    const event = await getCalendarEventForUser("at", "am1@applywizz.test", "evt-1", fetchImpl);
    expect(event).toBeNull();
  });
});

describe("createSubscription", () => {
  it("returns the subscription DTO with an expiry within the Graph cap", async () => {
    const dto = await createSubscription({
      accessToken: "at",
      notificationUrl:
        "https://app.example.com/api/webhooks/microsoft/calendar",
      clientState: "secret",
      fetchImpl: fakeFetch(201, {
        id: "sub-1",
        resource: "me/events",
        expirationDateTime: new Date(
          Date.now() + MAX_SUBSCRIPTION_MINUTES * 60 * 1000,
        ).toISOString(),
      }),
    });
    expect(dto.externalSubscriptionId).toBe("sub-1");
    expect(dto.resource).toBe("me/events");
    const minutesUntilExpiry =
      (new Date(dto.expiresAt).getTime() - Date.now()) / 60000;
    expect(minutesUntilExpiry).toBeLessThanOrEqual(
      MAX_SUBSCRIPTION_MINUTES + 1,
    );
  });
});

describe("renewSubscription", () => {
  it("returns a refreshed expiry", async () => {
    const dto = await renewSubscription(
      "at",
      "sub-1",
      fakeFetch(200, {
        id: "sub-1",
        resource: "me/events",
        expirationDateTime: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      }),
    );
    expect(dto.externalSubscriptionId).toBe("sub-1");
    expect(new Date(dto.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("deleteSubscription", () => {
  it("resolves on success", async () => {
    await expect(
      deleteSubscription("at", "sub-1", fakeFetch(204, {})),
    ).resolves.toBeUndefined();
  });

  it("treats 404 as already-gone, not an error", async () => {
    await expect(
      deleteSubscription("at", "sub-1", fakeFetch(404, {})),
    ).resolves.toBeUndefined();
  });

  it("throws on a real failure", async () => {
    await expect(
      deleteSubscription(
        "at",
        "sub-1",
        fakeFetch(500, { error: { code: "ServiceError" } }),
      ),
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("getCalendarEvent", () => {
  it("returns the normalized event when found", async () => {
    const event = await getCalendarEvent(
      "at",
      "evt-1",
      fakeFetch(200, { id: "evt-1", subject: "Sync", start: { dateTime: "x" }, end: { dateTime: "y" } }),
    );
    expect(event?.externalEventId).toBe("evt-1");
  });

  it("returns null on 404 (deleted event)", async () => {
    const event = await getCalendarEvent("at", "evt-1", fakeFetch(404, {}));
    expect(event).toBeNull();
  });

  it("throws a typed error on a real failure", async () => {
    await expect(
      getCalendarEvent("at", "evt-1", fakeFetch(500, { error: { code: "ServiceError" } })),
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("patchOnlineMeetingLobbyBypass", () => {
  function capturingFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ 
        url: typeof input === "string" ? input : input.toString(),
        body: init?.body as string,
      });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { fetchImpl, calls };
  }

  it("PATCHes /users/{userOid}/onlineMeetings/{id} with lobbyBypassSettings scope=everyone", async () => {
    const userOid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const meetingId = "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk_thread.v2_19:meeting_abc123";
    const { fetchImpl, calls } = capturingFetch(200, {});

    await patchOnlineMeetingLobbyBypass("test-token", userOid, meetingId, fetchImpl as unknown as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`/users/${userOid}/onlineMeetings/`);
    expect(calls[0]?.url).toContain(encodeURIComponent(meetingId));
    
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.lobbyBypassSettings.scope).toBe("everyone");
    expect(body.lobbyBypassSettings.isDialInBypassEnabled).toBe(false);
  });

  it("throws GraphApiError on permission denied (403)", async () => {
    const { fetchImpl } = capturingFetch(403, { 
      error: { code: "Forbidden", message: "Insufficient privileges" } 
    });

    await expect(
      patchOnlineMeetingLobbyBypass(
        "invalid-token", 
        "user-oid", 
        "meeting-id", 
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(GraphApiError);
  });

  it("throws GraphApiError on meeting not found (404)", async () => {
    const { fetchImpl } = capturingFetch(404, { 
      error: { code: "NotFound", message: "Online meeting not found" } 
    });

    await expect(
      patchOnlineMeetingLobbyBypass(
        "test-token", 
        "user-oid", 
        "nonexistent-meeting", 
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(GraphApiError);
  });
});

describe("addEchoAttendeeToOnlineMeeting", () => {
  function capturingFetch(status: number, body: unknown) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ 
        url: typeof input === "string" ? input : input.toString(),
        body: init?.body as string,
      });
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    };
    return { fetchImpl, calls };
  }

  it("PATCHes /users/{userOid}/onlineMeetings/{id} with Echo attendee (UPN only)", async () => {
    const userOid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const meetingId = "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk_thread.v2_19:meeting_abc123";
    const echoUpn = "Echo@Applywizz.ai";
    const { fetchImpl, calls } = capturingFetch(200, {});

    await addEchoAttendeeToOnlineMeeting("test-token", userOid, meetingId, echoUpn, null, fetchImpl as unknown as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`/users/${userOid}/onlineMeetings/`);
    expect(calls[0]?.url).toContain(encodeURIComponent(meetingId));
    
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.participants.attendees).toHaveLength(1);
    expect(body.participants.attendees[0].upn).toBe(echoUpn);
    expect(body.participants.attendees[0].identity).toBeUndefined();
  });

  it("PATCHes with Echo attendee (UPN + object ID)", async () => {
    const userOid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const meetingId = "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk_thread.v2_19:meeting_abc123";
    const echoUpn = "Echo@Applywizz.ai";
    const echoObjectId = "8b294bc6-1234-5678-abcd-456789fedcba";
    const { fetchImpl, calls } = capturingFetch(200, {});

    await addEchoAttendeeToOnlineMeeting("test-token", userOid, meetingId, echoUpn, echoObjectId, fetchImpl as unknown as typeof fetch);

    expect(calls).toHaveLength(1);
    
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.participants.attendees).toHaveLength(1);
    expect(body.participants.attendees[0].upn).toBe(echoUpn);
    expect(body.participants.attendees[0].identity.user.id).toBe(echoObjectId);
    expect(body.participants.attendees[0].identity.user.displayName).toBe("Echo");
  });

  it("throws GraphApiError on permission denied (403)", async () => {
    const { fetchImpl } = capturingFetch(403, { 
      error: { code: "Forbidden", message: "Insufficient privileges" } 
    });

    await expect(
      addEchoAttendeeToOnlineMeeting(
        "invalid-token", 
        "user-oid", 
        "meeting-id",
        "Echo@Applywizz.ai",
        null,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(GraphApiError);
  });

  it("throws GraphApiError on meeting not found (404)", async () => {
    const { fetchImpl } = capturingFetch(404, { 
      error: { code: "NotFound", message: "Online meeting not found" } 
    });

    await expect(
      addEchoAttendeeToOnlineMeeting(
        "test-token", 
        "user-oid", 
        "nonexistent-meeting",
        "Echo@Applywizz.ai",
        null,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toBeInstanceOf(GraphApiError);
  });

  it("is idempotent (adding Echo twice is safe)", async () => {
    const userOid = "6a184ab5-f989-4d9f-bad4-739731d3e936";
    const meetingId = "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk_thread.v2_19:meeting_abc123";
    const echoUpn = "Echo@Applywizz.ai";
    const { fetchImpl } = capturingFetch(200, {});

    // First call
    await addEchoAttendeeToOnlineMeeting("test-token", userOid, meetingId, echoUpn, null, fetchImpl as unknown as typeof fetch);
    
    // Second call (should not throw)
    await expect(
      addEchoAttendeeToOnlineMeeting("test-token", userOid, meetingId, echoUpn, null, fetchImpl as unknown as typeof fetch)
    ).resolves.toBeUndefined();
  });
});
