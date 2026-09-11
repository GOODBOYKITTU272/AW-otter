import { describe, expect, it } from "vitest";
import { normalizeAzureMaiResponse, type RawAzureMaiResponse } from "./mai_runner";

describe("Azure MAI Response Normalization Suite", () => {
  it("correctly preserves Speaker 0, Speaker 1, and ignores null/undefined without dropping 0", () => {
    const mockRaw: RawAzureMaiResponse = {
      durationMilliseconds: 19400,
      combinedPhrases: [{ text: "Turn 1 Turn 2 Turn 3" }],
      phrases: [
        {
          speaker: 0,
          offsetMilliseconds: 40,
          durationMilliseconds: 2560,
          text: "Turn 1",
          locale: "en",
          words: [{ text: "Turn", offsetMilliseconds: 40, durationMilliseconds: 100 }],
        },
        {
          speaker: 1,
          offsetMilliseconds: 2920,
          durationMilliseconds: 3180,
          text: "Turn 2",
          locale: "te",
          words: [{ text: "Turn", offsetMilliseconds: 2920, durationMilliseconds: 100 }],
        },
        {
          speaker: null,
          offsetMilliseconds: 6500,
          durationMilliseconds: 1000,
          text: "Turn 3",
          locale: "en",
        },
      ],
    };

    const normalized = normalizeAzureMaiResponse(mockRaw, 1200);

    expect(normalized.speakerCount).toBe(2);
    expect(normalized.speakers).toEqual([0, 1]);
    expect(normalized.phrases[0].speakerTag).toBe("Speaker 0");
    expect(normalized.phrases[0].speakerNumericId).toBe(0);
    expect(normalized.phrases[1].speakerTag).toBe("Speaker 1");
    expect(normalized.phrases[1].speakerNumericId).toBe(1);
    expect(normalized.phrases[2].speakerTag).toBe("speaker_unknown");
    expect(normalized.phrases[2].speakerNumericId).toBeNull();
  });

  it("calculates accurate endMs and duration for segments and words", () => {
    const mockRaw: RawAzureMaiResponse = {
      durationMilliseconds: 10000,
      phrases: [
        {
          speaker: 0,
          offsetMilliseconds: 1000,
          durationMilliseconds: 3500,
          text: "Test phrase",
          words: [
            { text: "Test", offsetMilliseconds: 1000, durationMilliseconds: 1500 },
            { text: "phrase", offsetMilliseconds: 2500, durationMilliseconds: 2000 },
          ],
        },
      ],
    };

    const res = normalizeAzureMaiResponse(mockRaw, 500);
    expect(res.phrases[0].startMs).toBe(1000);
    expect(res.phrases[0].endMs).toBe(4500);
    expect(res.phrases[0].words[0].endMs).toBe(2500);
    expect(res.phrases[0].words[1].endMs).toBe(4500);
  });
});
