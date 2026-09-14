import { describe, expect, it } from "vitest";
import {
  deriveMeetingOutcomeFromRecords,
  isMissingOutcomesTable,
  resolveMeetingOutcome,
  type MeetingOutcomeData,
} from "./meeting-outcome";

const SEG = "11111111-1111-1111-1111-111111111111";

describe("deriveMeetingOutcomeFromRecords", () => {
  it("maps decisions, action items, and questions from existing call records", () => {
    const outcome = deriveMeetingOutcomeFromRecords({
      summary: "Agreed on naming and a follow-up.",
      callRecords: [
        {
          recordType: "decision",
          description: "Use aw-echo naming.",
          ownerType: "am",
          ownerRef: "Priyanka",
          dueAt: null,
          evidenceSegmentIds: [SEG],
        },
        {
          recordType: "action_item",
          description: "Update provisioning docs.",
          ownerType: "am",
          ownerRef: "Priyanka",
          dueAt: "2026-05-23T00:00:00.000Z",
          evidenceSegmentIds: [SEG],
        },
        {
          recordType: "question",
          description: "How should we handle name conflicts?",
          ownerType: "other",
          ownerRef: null,
          dueAt: null,
          status: "detected",
          evidenceSegmentIds: [SEG],
        },
        {
          recordType: "commitment",
          description: "Should not appear as an Overview card type.",
          ownerType: "applywizz",
          ownerRef: null,
          dueAt: null,
          evidenceSegmentIds: [SEG],
        },
      ],
    });

    expect(outcome.source).toBe("derived");
    expect(outcome.summary).toBe("Agreed on naming and a follow-up.");
    expect(outcome.keyDecisions).toEqual([
      { text: "Use aw-echo naming.", evidenceSegmentIds: [SEG] },
    ]);
    expect(outcome.actionItems).toEqual([
      {
        description: "Update provisioning docs.",
        owner: "Priyanka",
        dueDate: "2026-05-23T00:00:00.000Z",
        evidenceSegmentIds: [SEG],
      },
    ]);
    expect(outcome.openQuestions).toEqual([
      {
        question: "How should we handle name conflicts?",
        status: "open",
        answer: null,
        evidenceSegmentIds: [SEG],
      },
    ]);
  });

  it("allows empty extracted arrays", () => {
    const outcome = deriveMeetingOutcomeFromRecords({
      summary: "Short check-in.",
      callRecords: [],
    });
    expect(outcome.keyDecisions).toEqual([]);
    expect(outcome.actionItems).toEqual([]);
    expect(outcome.openQuestions).toEqual([]);
  });
});

describe("resolveMeetingOutcome", () => {
  it("prefers a persisted meeting_outcomes row over derived recap data", () => {
    const persisted: MeetingOutcomeData = {
      summary: "Persisted summary",
      keyDecisions: [],
      actionItems: [],
      openQuestions: [],
      model: "openrouter",
      generatedAt: "2026-09-14T12:00:00Z",
      source: "persisted",
    };

    const resolved = resolveMeetingOutcome(persisted, {
      result: {
        summary: "Recap summary",
        callRecords: [
          {
            recordType: "decision",
            description: "Should not win.",
            ownerType: "am",
            ownerRef: null,
            dueAt: null,
            evidenceSegmentIds: [SEG],
          },
        ],
      },
    });

    expect(resolved?.summary).toBe("Persisted summary");
    expect(resolved?.source).toBe("persisted");
  });

  it("derives Overview cards when meeting_outcomes has no row", () => {
    const resolved = resolveMeetingOutcome(null, {
      result: {
        summary: "Recap summary",
        callRecords: [
          {
            recordType: "decision",
            description: "Ship Path C video.",
            ownerType: "am",
            ownerRef: null,
            dueAt: null,
            evidenceSegmentIds: [SEG],
          },
        ],
      },
    });

    expect(resolved?.source).toBe("derived");
    expect(resolved?.summary).toBe("Recap summary");
    expect(resolved?.keyDecisions[0]?.text).toBe("Ship Path C video.");
  });

  it("returns null when neither a persisted row nor a recap summary exists", () => {
    expect(resolveMeetingOutcome(null, null)).toBeNull();
  });
});

describe("isMissingOutcomesTable", () => {
  it("treats a missing-table error as non-fatal so Meeting Detail can still render", () => {
    expect(isMissingOutcomesTable({ code: "42P01", message: "relation does not exist" })).toBe(true);
    expect(isMissingOutcomesTable({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(isMissingOutcomesTable({ message: "Could not find the table 'public.meeting_outcomes'" })).toBe(true);
    expect(isMissingOutcomesTable({ code: "42501", message: "permission denied" })).toBe(false);
  });
});
