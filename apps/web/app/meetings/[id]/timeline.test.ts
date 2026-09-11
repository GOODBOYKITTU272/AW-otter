import { describe, expect, it } from "vitest";
import { computeProcessingTimeline } from "./timeline";

const BASE = { meetingCreatedAt: "2026-09-09T15:13:26Z" };

describe("computeProcessingTimeline", () => {
  it("marks every step done for a fully completed meeting", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: {
        status: "completed",
        joinedAt: "2026-09-09T15:16:20Z",
        leftAt: "2026-09-09T15:26:53Z",
        cancelledAt: null,
        failedAt: null,
      },
      transcript: { processingStatus: "completed", completedAt: "2026-09-09T15:50:33Z" },
      intelligenceStatus: "ready",
    });

    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(steps.find((s) => s.key === "recording")?.at).toBe("2026-09-09T15:26:53Z");
  });

  it("shows the bot as still waiting to join, recording pending", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: { status: "scheduled", joinedAt: null, leftAt: null, cancelledAt: null, failedAt: null },
      transcript: null,
      intelligenceStatus: "unknown",
    });

    expect(steps.find((s) => s.key === "joined")?.state).toBe("active");
    expect(steps.find((s) => s.key === "recording")?.state).toBe("pending");
    expect(steps.find((s) => s.key === "transcript")?.state).toBe("pending");
    expect(steps.find((s) => s.key === "analysis")?.state).toBe("pending");
  });

  it("marks joined + recording done, transcript still processing", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: { status: "completed", joinedAt: "2026-09-09T15:16:20Z", leftAt: "2026-09-09T15:26:53Z", cancelledAt: null, failedAt: null },
      transcript: { processingStatus: "processing", completedAt: null },
      intelligenceStatus: "unknown",
    });

    expect(steps.find((s) => s.key === "recording")?.state).toBe("done");
    expect(steps.find((s) => s.key === "transcript")?.state).toBe("active");
    expect(steps.find((s) => s.key === "analysis")?.state).toBe("pending");
  });

  it("marks analysis active once transcript is done but intelligence isn't ready yet", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: { status: "completed", joinedAt: "2026-09-09T15:16:20Z", leftAt: "2026-09-09T15:26:53Z", cancelledAt: null, failedAt: null },
      transcript: { processingStatus: "completed", completedAt: "2026-09-09T15:50:33Z" },
      intelligenceStatus: "not_ready",
    });

    expect(steps.find((s) => s.key === "analysis")?.state).toBe("active");
  });

  it("skips joined/recording entirely for a meeting with no bot job at all", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: null,
      transcript: null,
      intelligenceStatus: "unknown",
    });

    expect(steps.find((s) => s.key === "joined")?.state).toBe("skipped");
    expect(steps.find((s) => s.key === "recording")?.state).toBe("skipped");
  });

  it("marks joined failed and recording skipped when the bot never got in", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: { status: "failed", joinedAt: null, leftAt: null, cancelledAt: null, failedAt: "2026-09-09T15:32:00Z" },
      transcript: null,
      intelligenceStatus: "unknown",
    });

    expect(steps.find((s) => s.key === "joined")).toEqual({
      key: "joined",
      label: "Assistant joined",
      state: "failed",
      at: "2026-09-09T15:32:00Z",
    });
    expect(steps.find((s) => s.key === "recording")?.state).toBe("skipped");
  });

  it("surfaces a real transcription failure distinctly from a still-processing one", () => {
    const steps = computeProcessingTimeline({
      ...BASE,
      botJob: { status: "completed", joinedAt: "2026-09-09T15:16:20Z", leftAt: "2026-09-09T15:26:53Z", cancelledAt: null, failedAt: null },
      transcript: { processingStatus: "failed", completedAt: null },
      intelligenceStatus: "unknown",
    });

    expect(steps.find((s) => s.key === "transcript")?.state).toBe("failed");
  });
});
