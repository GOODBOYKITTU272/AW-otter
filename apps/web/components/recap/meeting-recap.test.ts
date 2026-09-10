import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MeetingRecapData } from "@applywizz/domain/meeting-recap";

import { getMeetingRecapFixture } from "../../fixtures/meeting-intelligence/fixtures";
import { MeetingRecap } from "./meeting-recap";

describe("MeetingRecap", () => {
  it("renders the required AM recap sections with transcript evidence", () => {
    const recap = getMeetingRecapFixture("renewal");
    if (!recap) throw new Error("Missing renewal fixture");

    const html = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap }),
    );

    expect(html).toContain("Priya Nair");
    expect(html).toContain("Renewal");
    expect(html).toContain("What Changed");
    expect(html).toContain("Actions");
    expect(html).toContain("Commitments");
    expect(html).toContain("Missing Info / Blockers");
    expect(html).toContain("Ask Signal");
    expect(html).toContain("0:24-0:39");
    expect(html).toContain("The first month got me two recruiter screens");
    // Fixture-preview data never sets customerSafeRecap — the section must
    // not appear (real-data-only).
    expect(html).not.toContain("Customer-safe version");
    // Codex Pass 2 (SHOULD-FIX, fixed): the component's own copy must never
    // say "fixture" — the real production recap route renders this exact
    // component, and this string used to leak into it via default empty
    // text and the Ask Signal placeholder.
    expect(html.toLowerCase()).not.toContain("fixture");
    // Codex Pass 2 (SHOULD-FIX, fixed): "View Meeting" is a real link, not
    // a permanently-disabled placeholder.
    expect(html).toContain(`href="/admin/meetings/${recap.id}"`);
    expect(html).not.toMatch(/disabled[^>]*>\s*View Meeting/);
  });

  it("shows a real-data status badge without requiring interactive controls (no id set)", () => {
    const recap = minimalRecap({
      customerTruthDeltas: [
        {
          fieldKey: "target_roles",
          previousValue: null,
          proposedValue: ["Backend Engineer"],
          confidence: 0.9,
          status: "confirmed",
          evidenceSegmentIds: [],
        },
      ],
      callRecords: [
        {
          recordType: "action_item",
          description: "Send updated resume.",
          ownerType: "customer",
          ownerRef: null,
          dueAt: null,
          status: "completed",
          evidenceSegmentIds: [],
        },
      ],
    });

    const html = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap }),
    );
    expect(html).toContain("Confirmed");
    expect(html).toContain("Completed");
  });

  it("renders the customer-safe recap section only when provided", () => {
    const recap = minimalRecap({ customerSafeRecap: null });
    const withoutSection = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap }),
    );
    expect(withoutSection).not.toContain("Customer-safe version");

    const recapWithSafe = minimalRecap({
      customerSafeRecap: {
        greeting: "Thanks for the call, Test Customer.",
        whatWeAgreed: ["We agreed on the plan."],
        applyWizzWillDo: [],
        customerShouldDo: [],
        nextStep: "No next call scheduled yet.",
      },
    });
    const withSection = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap: recapWithSafe }),
    );
    expect(withSection).toContain("Customer-safe version");
    expect(withSection).toContain("We agreed on the plan.");
  });

  it.each([
    {
      callType: "orientation" as const,
      label: "Confusion point",
      callTypeSpecific: {
        callType: "orientation" as const,
        initialExperienceSentiment: "neutral" as const,
        confusionPoints: [
          { text: "Unsure how matching works.", evidenceSegmentIds: [] },
        ],
        applicationQualityConcerns: [],
        targetingComplaints: [],
        immediateCorrectiveActions: [],
      },
    },
    {
      callType: "progress" as const,
      label: "Working",
      callTypeSpecific: {
        callType: "progress" as const,
        applicationsSubmittedCount: 12,
        responsesCount: 3,
        screensCount: 1,
        interviewsCount: 0,
        working: [
          {
            text: "Backend roles are landing screens.",
            evidenceSegmentIds: [],
          },
        ],
        notWorking: [],
        complaints: [],
        strategyChanges: [],
      },
    },
  ])(
    "renders call-specific notes for $callType",
    ({ label, callTypeSpecific }) => {
      const recap = minimalRecap({
        result: {
          summary: "Summary.",
          callRecords: [],
          customerTruthDeltas: [],
          callTypeSpecific,
        },
      });

      const html = renderToStaticMarkup(
        React.createElement(MeetingRecap, { recap }),
      );
      expect(html).toContain(label);
    },
  );

  it("renders editable buttons when canEdit is true", () => {
    const recap = minimalRecap({
      customerSafeRecap: {
        status: "draft",
        greeting: "Hello Candidate",
        whatWeAgreed: ["Agreement 1"],
        applyWizzWillDo: ["Action 1"],
        customerShouldDo: ["Candidate 1"],
        nextStep: "Follow up",
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap, canEdit: true }),
    );

    expect(html).toContain("Save Draft");
    expect(html).toContain("Approve Recap");
    expect(html).not.toContain("Read-only: Only the responsible Account Manager");
  });

  it("renders read-only note and hides review mutation buttons when canEdit is false", () => {
    const recap = minimalRecap({
      customerSafeRecap: {
        status: "draft",
        greeting: "Hello Candidate",
        whatWeAgreed: ["Agreement 1"],
        applyWizzWillDo: ["Action 1"],
        customerShouldDo: ["Candidate 1"],
        nextStep: "Follow up",
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(MeetingRecap, { recap, canEdit: false }),
    );

    expect(html).not.toContain("Save Draft");
    expect(html).not.toContain("Approve Recap");
    expect(html).toContain("Read-only: Only the responsible Account Manager can edit or approve this recap.");
  });
});

function minimalRecap(
  overrides: Partial<MeetingRecapData> & {
    callRecords?: MeetingRecapData["result"]["callRecords"];
    customerTruthDeltas?: MeetingRecapData["result"]["customerTruthDeltas"];
  } = {},
): MeetingRecapData {
  const { callRecords, customerTruthDeltas, result, ...rest } = overrides;
  return {
    id: "meeting-1",
    customer: {
      name: "Test Customer",
      lifecycleStage: "Discovery",
      ownerName: "AM",
    },
    meetingDate: "2026-09-03T15:30:00.000Z",
    nextJourneyStep: "No next call scheduled yet.",
    transcriptSegments: [],
    result: result ?? {
      summary: "Summary.",
      callRecords: callRecords ?? [],
      customerTruthDeltas: customerTruthDeltas ?? [],
      callTypeSpecific: null,
    },
    customerSafeRecap: undefined,
    ...rest,
  };
}
