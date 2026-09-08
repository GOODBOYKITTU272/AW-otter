import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
  });
});
