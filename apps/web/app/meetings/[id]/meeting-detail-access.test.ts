import { describe, expect, it } from "vitest";
import {
  canViewRawTranscript,
  meetingDetailTabKeys,
} from "./meeting-detail-access";

describe("meeting detail role gate", () => {
  it("hides the Transcript tab from account managers", () => {
    expect(canViewRawTranscript("account_manager")).toBe(false);
    expect(meetingDetailTabKeys("account_manager")).toEqual([
      "overview",
      "audio",
      "video",
      "insights",
    ]);
    expect(meetingDetailTabKeys("account_manager")).not.toContain("transcript");
  });

  it.each(["manager", "senior_manager", "admin"] as const)(
    "shows the Transcript tab to %s",
    (role) => {
      expect(canViewRawTranscript(role)).toBe(true);
      expect(meetingDetailTabKeys(role)).toEqual([
        "overview",
        "audio",
        "video",
        "transcript",
        "insights",
      ]);
    },
  );
});
