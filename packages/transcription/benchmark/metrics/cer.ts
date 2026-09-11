/**
 * Standardized Character Error Rate (CER) computation using dynamic programming Levenshtein distance.
 * Preserves all Unicode Letters (\p{L}), Marks (\p{M}), and Numbers (\p{N}), including Latin,
 * Devanagari, Telugu, Tamil, Kannada, and other scripts, while stripping punctuation and whitespace.
 */

export function normalizeTextForCer(text: string): string[] {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "")
    .split("");
}

export interface CerScore {
  cer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  refCharCount: number;
  hypCharCount: number;
}

export function computeCer(referenceText: string, hypothesisText: string): CerScore {
  const ref = normalizeTextForCer(referenceText);
  const hyp = normalizeTextForCer(hypothesisText);

  const n = ref.length;
  const m = hyp.length;

  if (n === 0) {
    return {
      cer: m === 0 ? 0 : 1,
      substitutions: 0,
      deletions: 0,
      insertions: m,
      refCharCount: 0,
      hypCharCount: m,
    };
  }

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
    cer: final.cost / n,
    substitutions: final.s,
    deletions: final.d,
    insertions: final.ins,
    refCharCount: n,
    hypCharCount: m,
  };
}
