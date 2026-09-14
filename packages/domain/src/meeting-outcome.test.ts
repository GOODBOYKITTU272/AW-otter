import { describe, expect, it } from "vitest";
import type { MeetingOutcomeData } from "./meeting-outcome";

describe("meeting-outcome", () => {
  it("defines the MeetingOutcomeData type shape", () => {
    const outcome: MeetingOutcomeData = {
      summary: "Test meeting summary",
      keyDecisions: [
        {
          text: "Decision to proceed",
          evidenceSegmentIds: ["seg-1"],
        },
      ],
      actionItems: [
        {
          description: "Send updated resume",
          owner: "Jane Doe",
          dueDate: "2026-09-20",
          evidenceSegmentIds: ["seg-2"],
        },
      ],
      openQuestions: [
        {
          question: "What is the timeline?",
          status: "open",
          answer: null,
          evidenceSegmentIds: ["seg-3"],
        },
      ],
      model: "gpt-4",
      generatedAt: "2026-09-14T12:00:00Z",
    };

    expect(outcome.summary).toBe("Test meeting summary");
    expect(outcome.keyDecisions).toHaveLength(1);
    expect(outcome.actionItems).toHaveLength(1);
    expect(outcome.openQuestions).toHaveLength(1);
    expect(outcome.model).toBe("gpt-4");
  });

  it("allows empty arrays for decisions, actions, and questions", () => {
    const outcome: MeetingOutcomeData = {
      summary: "Simple meeting",
      keyDecisions: [],
      actionItems: [],
      openQuestions: [],
      model: "gpt-4",
      generatedAt: "2026-09-14T12:00:00Z",
    };

    expect(outcome.keyDecisions).toHaveLength(0);
    expect(outcome.actionItems).toHaveLength(0);
    expect(outcome.openQuestions).toHaveLength(0);
  });

  it("supports answered questions", () => {
    const outcome: MeetingOutcomeData = {
      summary: "Meeting with Q&A",
      keyDecisions: [],
      actionItems: [],
      openQuestions: [
        {
          question: "When does the program start?",
          status: "answered",
          answer: "Next Monday",
          evidenceSegmentIds: ["seg-4", "seg-5"],
        },
      ],
      model: "gpt-4",
      generatedAt: "2026-09-14T12:00:00Z",
    };

    expect(outcome.openQuestions[0]?.status).toBe("answered");
    expect(outcome.openQuestions[0]?.answer).toBe("Next Monday");
  });
});
