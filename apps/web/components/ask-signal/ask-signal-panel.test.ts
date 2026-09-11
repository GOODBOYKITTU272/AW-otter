import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GROUNDING_CONFIG, SuggestedUpdateCard } from "./ask-signal-panel";

describe("AskSignalPanel Trust States & Cards", () => {
  it("provides clear, human-centered trust states without technical jargon", () => {
    expect(GROUNDING_CONFIG.supported.label).toBe("Verified from meeting");
    expect(GROUNDING_CONFIG.partially_supported.label).toBe(
      "Some evidence — check context",
    );
    expect(GROUNDING_CONFIG.unsupported.label).toBe(
      "Not supported by meeting records",
    );
    expect(GROUNDING_CONFIG.needs_review.label).toBe("Please review this part");
    expect(GROUNDING_CONFIG.conflicting.label).toBe(
      "Conflicting statements between meetings",
    );
    expect(GROUNDING_CONFIG.insufficient_evidence.label).toBe(
      "Echo couldn’t find enough evidence",
    );
  });

  it("renders SuggestedUpdateCard with field, value, speaker, timestamp, and transcript deep link", () => {
    const html = renderToStaticMarkup(
      React.createElement(SuggestedUpdateCard, {
        proposal: {
          id: "prop-123",
          fieldKey: "locations",
          proposedValue: ["Seattle, WA", "Remote"],
          status: "proposed",
          rationale: "Customer stated preference for Seattle or remote work.",
          evidenceSegmentId: "seg-456",
          sourceMeetingId: "meet-789",
          speakerName: "Jane Doe",
          speakerRole: "Customer",
          timestampMs: 125000,
        },
      }),
    );

    expect(html).toContain("Suggested Update");
    expect(html).toContain("locations");
    expect(html).toContain("Seattle, WA, Remote");
    expect(html).toContain("Customer stated preference for Seattle or remote work.");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Customer");
    expect(html).toContain("2:05");
    expect(html).toContain("Confirm Update");
    expect(html).toContain("Dismiss");
    expect(html).toContain("View in transcript");
    expect(html).toContain('/meetings/meet-789?tab=transcript#segment-seg-456');
  });
});
