/**
 * Grounds Meeting Outcome evidenceSegmentIds to real transcript segments and
 * picks claim-relevant quote windows so Overview never repeats the same
 * unrelated opener (e.g. "Milo…") across distinct questions.
 */

export interface OutcomeEvidenceSegment {
  id: string;
  text: string;
}

export interface GroundableDecision {
  text: string;
  evidenceSegmentIds: string[];
}

export interface GroundableActionItem {
  description: string;
  owner: string | null;
  dueDate: string | null;
  evidenceSegmentIds: string[];
}

export interface GroundableQuestion {
  question: string;
  status: "open" | "answered";
  answer: string | null;
  evidenceSegmentIds: string[];
}

export interface GroundableOutcome {
  summary: string;
  keyDecisions: GroundableDecision[];
  actionItems: GroundableActionItem[];
  openQuestions: GroundableQuestion[];
}

const STOP = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "what",
  "when",
  "where",
  "which",
  "your",
  "you",
  "are",
  "was",
  "were",
  "will",
  "can",
  "could",
  "should",
  "would",
  "about",
  "into",
  "just",
  "like",
  "them",
  "they",
  "their",
  "there",
  "then",
  "than",
  "also",
  "only",
  "some",
  "more",
  "most",
  "very",
  "over",
  "such",
  "did",
  "does",
  "doing",
  "our",
  "out",
  "any",
  "how",
  "who",
  "why",
  "not",
  "but",
  "all",
]);

export function tokenizeClaim(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

export function scoreClaimAgainstText(claim: string, segmentText: string): number {
  const tokens = tokenizeClaim(claim);
  if (tokens.length === 0) return 0;
  const hay = segmentText.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (hay.includes(token)) score += token.length >= 6 ? 2 : 1;
  }
  return score;
}

/**
 * Rank ALL segments by claim overlap. Cited ids only act as a tie-breaker so
 * a wrong shared citation (Milo mega-blob) loses when another segment fits.
 */
export function pickBestEvidenceSegmentId(
  claim: string,
  citedIds: string[],
  segments: OutcomeEvidenceSegment[],
): string | null {
  if (segments.length === 0) return null;
  const cited = new Set(citedIds);

  let best = segments[0]!;
  let bestScore = -1;

  for (const segment of segments) {
    let score = scoreClaimAgainstText(claim, segment.text);
    if (cited.has(segment.id)) score += 0.25; // mild preference only
    if (score > bestScore) {
      best = segment;
      bestScore = score;
    }
  }

  return best.id;
}

/**
 * Extract a claim-relevant snippet from a (possibly multi-topic) segment so
 * unrelated questions do not all show the same opening words.
 */
export function extractClaimSnippet(
  claim: string,
  segmentText: string,
  maxLen = 140,
): string {
  const cleaned = segmentText.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;

  const tokens = tokenizeClaim(claim).sort((a, b) => b.length - a.length);
  const lower = cleaned.toLowerCase();

  let anchor = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0) {
      anchor = idx;
      break;
    }
  }

  if (anchor < 0) {
    return `${cleaned.slice(0, maxLen).trimEnd()}…`;
  }

  let start = Math.max(0, anchor - Math.floor(maxLen / 5));
  const snapCandidates = [
    cleaned.lastIndexOf(". ", start + 20),
    cleaned.lastIndexOf("? ", start + 20),
    cleaned.lastIndexOf("! ", start + 20),
  ];
  const snap = Math.max(...snapCandidates);
  if (snap >= 0 && start - snap < 60 && snap < anchor) {
    start = snap + 2;
  }

  let snippet = cleaned.slice(start, start + maxLen).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (start + maxLen < cleaned.length) snippet = `${snippet.trimEnd()}…`;
  return snippet;
}

/**
 * Re-bind every Overview item to the best-matching real segment id and drop
 * hallucinated ids.
 */
export function groundMeetingOutcomeEvidence<T extends GroundableOutcome>(
  outcome: T,
  segments: OutcomeEvidenceSegment[],
): T {
  if (segments.length === 0) return outcome;

  const groundIds = (claim: string, cited: string[]): string[] => {
    const best = pickBestEvidenceSegmentId(claim, cited, segments);
    if (!best) {
      return cited.filter((id) => segments.some((s) => s.id === id)).slice(0, 1);
    }
    return [best];
  };

  return {
    ...outcome,
    keyDecisions: outcome.keyDecisions.map((d) => ({
      ...d,
      evidenceSegmentIds: groundIds(d.text, d.evidenceSegmentIds),
    })),
    actionItems: outcome.actionItems.map((a) => ({
      ...a,
      evidenceSegmentIds: groundIds(a.description, a.evidenceSegmentIds),
    })),
    openQuestions: outcome.openQuestions.map((q) => ({
      ...q,
      evidenceSegmentIds: groundIds(q.question, q.evidenceSegmentIds),
    })),
  };
}
