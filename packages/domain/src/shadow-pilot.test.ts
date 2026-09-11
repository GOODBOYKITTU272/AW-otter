import { describe, it, expect, vi } from "vitest";
import {
  compareShadowTranscription,
  recordShadowPilotRun,
  summarizeShadowPilotRuns,
  type ShadowTranscriptInput,
  type AppSupabaseClient,
} from "./shadow-pilot";

describe("Real Apply Wizz Shadow Pilot (P3F)", () => {
  const primaryInput: ShadowTranscriptInput = {
    providerName: "azure-mai",
    modelName: "azure-multilingual-ai",
    fullText: "Hello Kartik this is Rama from Apply Wizz welcome to our onboarding session today.",
    speakerLabels: ["Speaker 0", "Speaker 0", "Speaker 1"],
    durationMs: 30000,
    detectedLanguage: "en",
    integrityVerdict: "good",
  };

  const shadowInputHighAgreement: ShadowTranscriptInput = {
    providerName: "openrouter",
    modelName: "openai/whisper-large-v3-turbo",
    fullText: "Hello Kartik, this is Rama from Apply Wizz. Welcome to our onboarding session today.",
    speakerLabels: ["Speaker 0", "Speaker 0", "Speaker 1"],
    durationMs: 30000,
    detectedLanguage: "en",
    integrityVerdict: "good",
  };

  const shadowInputDivergent: ShadowTranscriptInput = {
    providerName: "openrouter",
    modelName: "openai/whisper-large-v3-turbo",
    fullText: "Thank you for watching. Please subscribe to our channel and like the video.",
    speakerLabels: ["Speaker 0"],
    durationMs: 30000,
    detectedLanguage: "en",
    integrityVerdict: "needs_review",
  };

  it("evaluates high concordance between primary Azure and shadow Whisper as promote", () => {
    const result = compareShadowTranscription(
      primaryInput,
      shadowInputHighAgreement,
      1200,
      2400,
    );

    expect(result.primaryProvider).toBe("azure-mai:azure-multilingual-ai");
    expect(result.shadowProvider).toBe("openrouter:openai/whisper-large-v3-turbo");
    expect(result.textAgreementPercentage).toBeGreaterThanOrEqual(90);
    expect(result.languageAgreement).toBe(true);
    expect(result.verdictAgreement).toBe(true);
    expect(result.recommendation).toBe("promote");
    expect(result.latencyDeltaMs).toBe(1200);
    expect(result.primarySpeakerCount).toBe(2);
    expect(result.shadowSpeakerCount).toBe(2);
  });

  it("flags divergent transcripts for investigation", () => {
    const result = compareShadowTranscription(
      primaryInput,
      shadowInputDivergent,
      1200,
      1500,
    );

    expect(result.textAgreementPercentage).toBeLessThan(50);
    expect(result.verdictAgreement).toBe(false);
    expect(result.recommendation).toBe("investigate");
  });

  it("recordShadowPilotRun logs audit event without mutating primary tables", async () => {
    let auditEventPayload: Record<string, unknown> | null = null;

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "audit_events") {
          return {
            insert: vi.fn((payload: Record<string, unknown>) => {
              auditEventPayload = payload;
              return Promise.resolve({ error: null });
            }),
          };
        }
        // Primary tables should never be called for writes!
        return {
          update: vi.fn().mockImplementation(() => {
            throw new Error("Primary table write attempted during shadow run!");
          }),
          delete: vi.fn().mockImplementation(() => {
            throw new Error("Primary table delete attempted during shadow run!");
          }),
        };
      }),
    } as unknown as AppSupabaseClient;

    const res = await recordShadowPilotRun(mockClient, {
      organizationId: "org-1111",
      meetingId: "meeting-2222",
      actorId: "actor-3333",
      primary: primaryInput,
      shadow: shadowInputHighAgreement,
      latencyMsPrimary: 1100,
      latencyMsShadow: 2200,
    });

    expect(res.recommendation).toBe("promote");
    expect(auditEventPayload).not.toBeNull();
    expect(auditEventPayload?.["action"]).toBe("transcription.shadow_evaluated");
    expect(auditEventPayload?.["entity_type"]).toBe("meeting_transcripts");
    expect(auditEventPayload?.["entity_id"]).toBe("meeting-2222");

    const metadata = (auditEventPayload?.["metadata"] ?? {}) as Record<string, unknown>;
    expect(metadata["primaryProvider"]).toBe("azure-mai:azure-multilingual-ai");
    expect(metadata["textAgreementPercentage"]).toBeGreaterThanOrEqual(90);
  });

  it("summarizes shadow pilot batches accurately", () => {
    const run1 = compareShadowTranscription(primaryInput, shadowInputHighAgreement, 1000, 2000);
    const run2 = compareShadowTranscription(primaryInput, shadowInputHighAgreement, 1100, 2100);
    const run3 = compareShadowTranscription(primaryInput, shadowInputDivergent, 1000, 1500);

    const summary = summarizeShadowPilotRuns([run1, run2, run3]);
    expect(summary.totalCalls).toBe(3);
    expect(summary.acceptableOrPromoteCount).toBe(2);
    expect(summary.investigateCount).toBe(1);
    expect(summary.averageAgreementPercentage).toBeGreaterThan(60);
  });

  it("handles empty shadow pilot batch gracefully", () => {
    const summary = summarizeShadowPilotRuns([]);
    expect(summary.totalCalls).toBe(0);
    expect(summary.overallPilotStatus).toBe("NEEDS_TUNING");
  });
});
