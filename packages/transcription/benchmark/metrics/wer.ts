/**
 * Standardized Word Error Rate (WER) computation using dynamic programming Levenshtein distance.
 * Normalizes text (case, punctuation) to avoid spurious differences.
 */

export function normalizeTextForEvaluation(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u0900-\u097F\u0C00-\u0C7F]/g, "") // preserve English, Devanagari, Telugu scripts
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export interface WerScore {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refWordCount: number;
  hypWordCount: number;
}

export function computeWer(referenceText: string, hypothesisText: string): WerScore {
  const ref = normalizeTextForEvaluation(referenceText);
  const hyp = normalizeTextForEvaluation(hypothesisText);

  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    return {
      wer: m === 0 ? 0 : 1,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      refWordCount: 0,
      hypWordCount: m,
    };
  }

  // dp[i][j] stores { cost, s, d, ins }
  const dp: { cost: number; s: number; d: number; ins: number }[][] = Array.from(
    { length: n + 1 },
    () => Array.from({ length: m + 1 }, () => ({ cost: 0, s: 0, d: 0, ins: 0 }))
  );

  for (let i = 0; i <= n; i++) {
    dp[i][0] = { cost: i, s: 0, d: i, ins: 0 };
  }
  for (let j = 0; j <= m; j++) {
    dp[0][j] = { cost: j, s: 0, d: 0, ins: j };
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        dp[i][j] = { ...dp[i - 1][j - 1] };
      } else {
        const substitution = dp[i - 1][j - 1].cost + 1;
        const deletion = dp[i - 1][j].cost + 1;
        const insertion = dp[i][j - 1].cost + 1;

        if (substitution <= deletion && substitution <= insertion) {
          dp[i][j] = {
            cost: substitution,
            s: dp[i - 1][j - 1].s + 1,
            d: dp[i - 1][j - 1].d,
            ins: dp[i - 1][j - 1].ins,
          };
        } else if (deletion <= insertion) {
          dp[i][j] = {
            cost: deletion,
            s: dp[i - 1][j].s,
            d: dp[i - 1][j].d + 1,
            ins: dp[i - 1][j].ins,
          };
        } else {
          dp[i][j] = {
            cost: insertion,
            s: dp[i][j - 1].s,
            d: dp[i][j - 1].d,
            ins: dp[i][j - 1].ins + 1,
          };
        }
      }
    }
  }

  const final = dp[n][m];
  return {
    wer: final.cost / n,
    substitutions: final.s,
    deletions: final.d,
    insertions: final.ins,
    refWordCount: n,
    hypWordCount: m,
  };
}
