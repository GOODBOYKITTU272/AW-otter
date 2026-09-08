import { describe, expect, it } from "vitest";
import { meetingIntelligenceResultSchema } from "@applywizz/ai";

import { meetingRecapFixtures } from "./fixtures";

describe("meeting recap fixtures", () => {
  it("each fixture's result is a valid instance of the real M9 Zod contract (Codex review NIT, fixed)", () => {
    for (const fixture of meetingRecapFixtures) {
      const result = meetingIntelligenceResultSchema.safeParse(fixture.result);
      expect(result.success).toBe(true);
    }
  });

  it("cover required call types with transcript-backed evidence", () => {
    expect(
      meetingRecapFixtures.map(
        (fixture) => fixture.result.callTypeSpecific?.callType,
      ),
    ).toEqual(["discovery", "resume_review", "renewal"]);

    for (const fixture of meetingRecapFixtures) {
      const segmentIds = new Set(
        fixture.transcriptSegments.map((segment) => segment.id),
      );

      expect(fixture.customer.name).toBeTruthy();
      expect(fixture.meetingDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(fixture.nextJourneyStep).toBeTruthy();
      expect(fixture.result.summary).toBeTruthy();

      for (const record of fixture.result.callRecords) {
        expect(record.evidenceSegmentIds.length).toBeGreaterThan(0);
        expect(
          record.evidenceSegmentIds.every((id) => segmentIds.has(id)),
        ).toBe(true);
      }

      for (const delta of fixture.result.customerTruthDeltas) {
        expect(delta.evidenceSegmentIds.length).toBeGreaterThan(0);
        expect(delta.evidenceSegmentIds.every((id) => segmentIds.has(id))).toBe(
          true,
        );
      }

      const callTypeSpecific = fixture.result.callTypeSpecific;
      expect(callTypeSpecific).not.toBeNull();
      if (!callTypeSpecific) continue;

      for (const claimList of claimLists(callTypeSpecific)) {
        for (const claim of claimList) {
          expect(typeof claim).toBe("object");
          expect(claim.text).toBeTruthy();
          expect(claim.evidenceSegmentIds.length).toBeGreaterThan(0);
          expect(
            claim.evidenceSegmentIds.every((id) => segmentIds.has(id)),
          ).toBe(true);
        }
      }
    }
  });
});

function claimLists(
  callTypeSpecific: NonNullable<
    (typeof meetingRecapFixtures)[number]["result"]["callTypeSpecific"]
  >,
) {
  switch (callTypeSpecific.callType) {
    case "discovery":
      return [
        callTypeSpecific.goals,
        callTypeSpecific.constraints,
        callTypeSpecific.newInformation,
        callTypeSpecific.resumeTeamNeeds,
      ];
    case "resume_review":
      return [
        callTypeSpecific.resumeChangesRequested,
        callTypeSpecific.resumeChangesAccepted,
        callTypeSpecific.resumeChangesRejected,
        callTypeSpecific.positioningChanges,
        callTypeSpecific.skillCorrections,
        callTypeSpecific.roleTargetingChanges,
      ];
    case "renewal":
      return [
        callTypeSpecific.valueDelivered,
        callTypeSpecific.unresolvedProblems,
        callTypeSpecific.objections,
        callTypeSpecific.churnRiskEvidence,
        callTypeSpecific.nextMonthStrategy,
      ];
    default:
      return [];
  }
}
