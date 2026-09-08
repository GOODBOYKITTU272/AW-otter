/**
 * Bounded reconciliation window (revised M7A plan: "incremental bounded
 * reconciliation, not download all 5,196 records repeatedly"). Lookback is
 * short — just enough to pick up a status flip (SCHEDULED -> COMPLETED/
 * MISSED_BY_AM/NOT_PICKED/RESCHEDULED) on a call that recently passed.
 * Lookahead matches Microsoft's own INITIAL_SYNC_WINDOW_DAYS
 * (@applywizz/microsoft/config) so both sources cover the same horizon.
 */
export const RECONCILE_LOOKBACK_DAYS = 3;
export const RECONCILE_LOOKAHEAD_DAYS = 30;

/** Single GET, ~1.7s observed for ~1,000 rows against the real endpoint. */
export const DEFAULT_TIMEOUT_MS = 15_000;
