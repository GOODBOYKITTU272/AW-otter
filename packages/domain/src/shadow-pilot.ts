import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import { logAuditEvent } from "./audit";

export type AppSupabaseClient = SupabaseClient<Database>;

export interface ShadowTranscriptInput {
  providerName: string;
  modelName: string;
  fullText: string;
  speakerLabels: string[];
  durationMs?: number;
  detectedLanguage?: string | null;
  integrityVerdict?: string | null;
}

export interface ShadowComparisonResult {
  primaryProvider: string;
  shadowProvider: string;
  textAgreementPercentage: number;
  wordCountRatio: number;
  primaryWordCount: number;
  shadowWordCount: number;
  primarySpeakerCount: number;
  shadowSpeakerCount: number;
  latencyDeltaMs: number;
  languageAgreement: boolean;
  verdictAgreement: boolean;
  recommendation: "promote" | "investigate" | "acceptable";
  summary: string;
}

export interface RecordShadowPilotInput {
  organizationId: string;
  meetingId: string;
  actorId?: string | null;
  primary: ShadowTranscriptInput;
  shadow: ShadowTranscriptInput;
  latencyMsPrimary: number;
  latencyMsShadow: number;
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

/**
 * Computes token-level intersection similarity between primary and shadow texts.
 */
function computeTokenSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  const countA = new Map<string, number>();
  for (const t of tokensA) {
    countA.set(t, (countA.get(t) ?? 0) + 1);
  }

  let intersection = 0;
  for (const t of tokensB) {
    const c = countA.get(t) ?? 0;
    if (c > 0) {
      intersection++;
      countA.set(t, c - 1);
    }
  }

  const denominator = Math.max(tokensA.length, tokensB.length);
  return Number((intersection / denominator).toFixed(4));
}

/**
 * Compares primary STT execution against a shadow secondary STT execution on real meeting data.
 * Pure deterministic evaluation without side-effects.
 */
export function compareShadowTranscription(
  primary: ShadowTranscriptInput,
  shadow: ShadowTranscriptInput,
  latencyMsPrimary = 0,
  latencyMsShadow = 0,
): ShadowComparisonResult {
  const primaryTokens = normalizeTokens(primary.fullText);
  const shadowTokens = normalizeTokens(shadow.fullText);

  const similarity = computeTokenSimilarity(primaryTokens, shadowTokens);
  const textAgreementPercentage = Number((similarity * 100).toFixed(1));

  const primaryWordCount = primaryTokens.length;
  const shadowWordCount = shadowTokens.length;
  const wordCountRatio =
    primaryWordCount > 0
      ? Number((shadowWordCount / primaryWordCount).toFixed(2))
      : 1.0;

  const primaryUniqueSpeakers = new Set(primary.speakerLabels).size;
  const shadowUniqueSpeakers = new Set(shadow.speakerLabels).size;

  const languageAgreement =
    Boolean(primary.detectedLanguage && shadow.detectedLanguage)
      ? primary.detectedLanguage === shadow.detectedLanguage
      : true;

  const verdictAgreement =
    Boolean(primary.integrityVerdict && shadow.integrityVerdict)
      ? primary.integrityVerdict === shadow.integrityVerdict
      : true;

  const latencyDeltaMs = latencyMsShadow - latencyMsPrimary;

  let recommendation: "promote" | "investigate" | "acceptable" = "acceptable";
  let summary = `Primary (${primary.providerName}) and Shadow (${shadow.providerName}) show good alignment (${textAgreementPercentage}% agreement).`;

  if (textAgreementPercentage < 60) {
    recommendation = "investigate";
    summary = `Significant divergence between primary and shadow transcripts (${textAgreementPercentage}% agreement). Investigation advised.`;
  } else if (textAgreementPercentage >= 85 && languageAgreement && verdictAgreement) {
    recommendation = "promote";
    summary = `High concord between primary and shadow (${textAgreementPercentage}% agreement, identical language/integrity verdicts).`;
  }

  return {
    primaryProvider: `${primary.providerName}:${primary.modelName}`,
    shadowProvider: `${shadow.providerName}:${shadow.modelName}`,
    textAgreementPercentage,
    wordCountRatio,
    primaryWordCount,
    shadowWordCount,
    primarySpeakerCount: primaryUniqueSpeakers,
    shadowSpeakerCount: shadowUniqueSpeakers,
    latencyDeltaMs,
    languageAgreement,
    verdictAgreement,
    recommendation,
    summary,
  };
}

/**
 * Persists shadow pilot comparison audit event into public.audit_events.
 *
 * Invariant: NEVER mutates public.meeting_transcripts, transcript_segments, or meeting_recaps.
 */
export async function recordShadowPilotRun(
  client: AppSupabaseClient,
  input: RecordShadowPilotInput,
): Promise<ShadowComparisonResult> {
  const comparison = compareShadowTranscription(
    input.primary,
    input.shadow,
    input.latencyMsPrimary,
    input.latencyMsShadow,
  );

  await logAuditEvent(client, {
    organizationId: input.organizationId,
    actorId: input.actorId ?? null,
    action: "transcription.shadow_evaluated",
    entityType: "meeting_transcripts",
    entityId: input.meetingId,
    metadata: {
      primaryProvider: comparison.primaryProvider,
      shadowProvider: comparison.shadowProvider,
      textAgreementPercentage: comparison.textAgreementPercentage,
      wordCountRatio: comparison.wordCountRatio,
      primaryWordCount: comparison.primaryWordCount,
      shadowWordCount: comparison.shadowWordCount,
      primarySpeakerCount: comparison.primarySpeakerCount,
      shadowSpeakerCount: comparison.shadowSpeakerCount,
      latencyDeltaMs: comparison.latencyDeltaMs,
      languageAgreement: comparison.languageAgreement,
      verdictAgreement: comparison.verdictAgreement,
      recommendation: comparison.recommendation,
      summary: comparison.summary,
    },
  });

  return comparison;
}

export interface ShadowPilotBatchSummary {
  totalCalls: number;
  averageAgreementPercentage: number;
  acceptableOrPromoteCount: number;
  investigateCount: number;
  averageLatencyDeltaMs: number;
  overallPilotStatus: "PASS" | "NEEDS_TUNING";
}

/**
 * Aggregates results from a pilot batch of shadow runs.
 */
export function summarizeShadowPilotRuns(
  runs: ShadowComparisonResult[],
): ShadowPilotBatchSummary {
  if (runs.length === 0) {
    return {
      totalCalls: 0,
      averageAgreementPercentage: 0,
      acceptableOrPromoteCount: 0,
      investigateCount: 0,
      averageLatencyDeltaMs: 0,
      overallPilotStatus: "NEEDS_TUNING",
    };
  }

  const totalCalls = runs.length;
  const totalAgreement = runs.reduce((acc, r) => acc + r.textAgreementPercentage, 0);
  const averageAgreementPercentage = Number((totalAgreement / totalCalls).toFixed(1));

  const totalLatencyDelta = runs.reduce((acc, r) => acc + r.latencyDeltaMs, 0);
  const averageLatencyDeltaMs = Math.round(totalLatencyDelta / totalCalls);

  const acceptableOrPromoteCount = runs.filter(
    (r) => r.recommendation === "acceptable" || r.recommendation === "promote",
  ).length;
  const investigateCount = runs.filter((r) => r.recommendation === "investigate").length;

  const overallPilotStatus =
    averageAgreementPercentage >= 75 && investigateCount <= totalCalls * 0.2
      ? "PASS"
      : "NEEDS_TUNING";

  return {
    totalCalls,
    averageAgreementPercentage,
    acceptableOrPromoteCount,
    investigateCount,
    averageLatencyDeltaMs,
    overallPilotStatus,
  };
}
