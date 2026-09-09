import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MeetingPrepData } from "@applywizz/domain/meeting-prep";
import { MeetingPrep } from "./meeting-prep";

function minimalPrep(
  overrides: Partial<MeetingPrepData> = {},
): MeetingPrepData {
  return {
    meetingId: "meeting-1",
    customer: {
      id: "cust-1",
      name: "Test Customer",
      lifecycleStage: "Progress",
    },
    callType: "resume_review",
    scheduledAt: "2026-09-10T15:00:00.000Z",
    previousMeeting: { status: "none" },
    openItems: [],
    currentTruth: [],
    pendingTruth: [],
    recentChanges: [],
    journey: { previousCall: null, nextCall: null },
    serviceEnd: null,
    recommendedFocus: [],
    ...overrides,
  };
}

describe("MeetingPrep", () => {
  it("renders the call-type-specific prep section from the previous meeting (Codex Pass 2 BLOCKING regression)", () => {
    const prep = minimalPrep({
      previousMeeting: {
        status: "ready",
        callType: "discovery",
        scheduledAt: "2026-09-01T00:00:00.000Z",
        summary: "Discovery summary.",
        keyActions: [],
        blockers: [],
        confirmedTruthChanges: [],
        transcriptSegments: [],
        callTypeSpecific: {
          callType: "discovery",
          onboardingCompleteness: {
            complete: false,
            missingFields: ["compensation"],
          },
          goals: [{ text: "SPECIFIC_GOAL_TEXT", evidenceSegmentIds: [] }],
          constraints: [],
          contradictionsWithOnboarding: [],
          newInformation: [],
          resumeTeamNeeds: [],
        },
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(MeetingPrep, { prep }),
    );
    expect(html).toContain("Discovery prep");
    expect(html).toContain("SPECIFIC_GOAL_TEXT");
    expect(html).toContain("compensation");
  });

  it("never silently hides Pending confirmations / Recent changes / previous-meeting blockers when empty — shows real empty-state copy instead (Codex Pass 2 SHOULD-FIX regression)", () => {
    const prep = minimalPrep({
      previousMeeting: {
        status: "ready",
        callType: "progress",
        scheduledAt: "2026-09-01T00:00:00.000Z",
        summary: "Progress summary.",
        keyActions: [],
        blockers: [],
        confirmedTruthChanges: [],
        transcriptSegments: [],
        callTypeSpecific: null,
      },
      pendingTruth: [],
      recentChanges: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(MeetingPrep, { prep }),
    );
    expect(html).toContain("No pending Customer Truth changes.");
    expect(html).toContain("No recently confirmed changes.");
    expect(html).toContain("No blockers or open questions from the last call.");
  });

  it("renders the correct empty state for a brand-new customer with no prior meeting", () => {
    const prep = minimalPrep({ previousMeeting: { status: "none" } });
    const html = renderToStaticMarkup(
      React.createElement(MeetingPrep, { prep }),
    );
    expect(html).toContain("this is the first call");
  });

  it("renders the correct empty state when the previous meeting's intelligence isn't ready yet", () => {
    const prep = minimalPrep({ previousMeeting: { status: "not_ready" } });
    const html = renderToStaticMarkup(
      React.createElement(MeetingPrep, { prep }),
    );
    expect(html).toContain("intelligence is ready");
  });
});
