import { describe, expect, it } from "vitest";
import {
  extractClaimSnippet,
  groundMeetingOutcomeEvidence,
  pickBestEvidenceSegmentId,
  scoreClaimAgainstText,
} from "./meeting-outcome-evidence";

const MILO = {
  id: "144d1787-bfb0-4e6f-b381-c03676985aaa",
  text: "Was my bot name proposed, Milo? I want our company logo. Can we push it to 10 meetings? Did we build the screen recording?",
};
const SUPABASE = {
  id: "63fd9f02-6557-4e73-9189-34c27347bbed",
  text: "Let's store this bot ID in Supabase. Once we store it, trigger it 1 minute and 30 seconds before.",
};
const SEGMENTS = [MILO, SUPABASE];

describe("meeting-outcome-evidence", () => {
  it("scores claim tokens against segment text", () => {
    expect(scoreClaimAgainstText("store bot ID in Supabase", SUPABASE.text)).toBeGreaterThan(
      scoreClaimAgainstText("store bot ID in Supabase", MILO.text),
    );
  });

  it("rebinds a Supabase action away from the Milo mega-segment", () => {
    const id = pickBestEvidenceSegmentId(
      "Store bot ID in Supabase and trigger 90 seconds before",
      [MILO.id],
      SEGMENTS,
    );
    expect(id).toBe(SUPABASE.id);
  });

  it("extracts a claim-relevant snippet instead of always opening on Milo", () => {
    const concurrency = extractClaimSnippet("Can we push concurrency to 10 meetings?", MILO.text, 80);
    expect(concurrency.toLowerCase()).toContain("10");
    expect(concurrency.toLowerCase()).not.toMatch(/^was my bot name proposed, milo/);

    const recording = extractClaimSnippet("Did we build the screen recording feature?", MILO.text, 80);
    expect(recording.toLowerCase()).toContain("screen recording");
  });

  it("grounds an outcome so unrelated questions do not keep a bad shared citation when a better segment exists", () => {
    const grounded = groundMeetingOutcomeEvidence(
      {
        summary: "Discussed bot naming and Supabase dispatch.",
        keyDecisions: [
          {
            text: "Store bot IDs in Supabase.",
            evidenceSegmentIds: [MILO.id],
          },
        ],
        actionItems: [
          {
            description: "Trigger bot 90 seconds before the meeting.",
            owner: null,
            dueDate: null,
            evidenceSegmentIds: [MILO.id],
          },
        ],
        openQuestions: [
          {
            question: "Did we build screen recording?",
            status: "open",
            answer: null,
            evidenceSegmentIds: [MILO.id],
          },
        ],
      },
      SEGMENTS,
    );

    expect(grounded.keyDecisions[0]!.evidenceSegmentIds).toEqual([SUPABASE.id]);
    expect(grounded.actionItems[0]!.evidenceSegmentIds).toEqual([SUPABASE.id]);
    expect(grounded.openQuestions[0]!.evidenceSegmentIds).toEqual([MILO.id]);
  });
});
