import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";
import type { NormalizedCrmBaseline } from "@applywizz/crm";

export type AppSupabaseClient = SupabaseClient<Database>;

const CALL_TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  resume_review: "Resume Review",
  orientation: "Orientation",
  progress: "Progress Review",
  renewal: "Renewal",
  other_unknown: "Other / Unknown",
};

const DUE_SOON_WINDOW_DAYS = 7;
const SERVICE_END_HIGH_WINDOW_DAYS = 7;
const SERVICE_END_MEDIUM_WINDOW_DAYS = 14;
const CALL_SOON_WINDOW_DAYS = 3;

/** The timezone's UTC offset, in minutes, AT the given instant (not at "now"). */
function utcOffsetMinutesAt(timezone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) map[part.type] = part.value;
  const asUtcLabeled = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    map.hour === "24" ? 0 : Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  // Real-world UTC offsets are always a whole number of minutes.
  // `formatToParts` only has whole-second precision, so `asUtcLabeled`
  // silently drops any sub-second part of `at` — rounding here removes
  // that truncation artifact instead of letting it leak into the final
  // instant (caught during verification: an end-of-day `.999`ms boundary
  // was landing ~1s off without this rounding).
  return Math.round((asUtcLabeled - at.getTime()) / 60000);
}

/**
 * The UTC instant for a specific wall-clock local time (y, m, d, h, min, s)
 * in `timezone`. Two-pass fixed-point iteration: the offset can differ
 * between "now" and the target wall-clock time on a DST transition day, so
 * the offset must be resolved AT the target instant itself, not borrowed
 * from `now` (Codex Pass 2 SHOULD-FIX, fixed — the previous version reused
 * one offset computed from `now` for both midnight boundaries, which is
 * wrong whenever midnight and `now` fall on opposite sides of a DST
 * transition; e.g. America/New_York, 2026-03-08 (a real US spring-forward
 * date), start-of-day was computed as 04:00Z when the correct value is
 * 05:00Z). One correction pass is sufficient since real-world DST jumps are
 * always a whole/half hour, never large enough to need more than one.
 */
function utcForLocalWallClock(
  timezone: string,
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  s: number,
  ms: number,
): number {
  let guessUtc = Date.UTC(y, m, d, h, min, s, ms);
  for (let i = 0; i < 2; i++) {
    const offsetMin = utcOffsetMinutesAt(timezone, new Date(guessUtc));
    guessUtc = Date.UTC(y, m, d, h, min, s, ms) - offsetMin * 60000;
  }
  return guessUtc;
}

/**
 * Timezone-correct "today" boundaries for the organization (never UTC-only,
 * never the server's/browser's local time, which may not match the AM's
 * actual business timezone) — correct across DST transitions (see
 * `utcForLocalWallClock`).
 */
export function getOrgTodayRange(
  timezone: string,
  now: Date = new Date(),
): { startUtc: string; endUtc: string } {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const part of dateParts) map[part.type] = part.value;
  const y = Number(map.year);
  const m = Number(map.month) - 1;
  const d = Number(map.day);

  return {
    startUtc: new Date(
      utcForLocalWallClock(timezone, y, m, d, 0, 0, 0, 0),
    ).toISOString(),
    endUtc: new Date(
      utcForLocalWallClock(timezone, y, m, d, 23, 59, 59, 999),
    ).toISOString(),
  };
}

export type AttentionLevel = "high" | "medium" | "normal";

export interface AttentionReason {
  code: string;
  label: string;
  level: "high" | "medium";
}

export interface CustomerAttention {
  level: AttentionLevel;
  reasons: AttentionReason[];
}

export interface PortfolioCallSummary {
  callType: string | null;
  scheduledAt: string;
  meetingId: string | null;
}

export interface OpenCallRecordSummary {
  id: string;
  description: string;
  recordType: string;
  dueAt: string | null;
}

export interface PortfolioCustomerRow {
  customerId: string;
  name: string;
  lifecycleStage: string | null;
  nextCall: PortfolioCallSummary | null;
  lastCall: PortfolioCallSummary | null;
  isCallToday: boolean;
  todaysCalls: PortfolioCallSummary[];
  openActionCount: number;
  overdueActionCount: number;
  dueTodayActionCount: number;
  dueSoonActionCount: number;
  openBlockerCount: number;
  pendingTruthCount: number;
  serviceEnd: string | null;
  /**
   * Codex-independent-review SHOULD-FIX (fixed): this is the ONLY place
   * "days until service end" is computed — org-timezone calendar-day
   * math, same as everywhere else in this file. Callers must use this
   * field directly and must never re-derive it from a raw UTC date-string
   * compare (that reintroduces exactly the "in 1 day" / dropped-same-day
   * class of bug this file exists to fix).
   */
  serviceEndDaysAway: number | null;
  lastMeaningfulUpdateAt: string | null;
  attention: CustomerAttention;
}

/**
 * Real bug found in local product review: a call happening later TODAY
 * (e.g. 3 hours from now) computed as `Math.ceil(3/24)` = 1 under naive
 * millisecond division — showing "call in 1 day" in the attention reason
 * while the SAME call correctly appeared under "Today's Calls" (which
 * already used real calendar-day boundaries via `getOrgTodayRange`). Two
 * inconsistent day-math systems for the same underlying question. Fixed
 * by making every human-facing "N days away" label use the same org-
 * timezone calendar-day boundaries as "today" itself — diffing two
 * timezone-local midnights (always a whole number of days apart) instead
 * of a fractional millisecond delta.
 */
export function calendarDayOffset(
  timezone: string,
  from: Date,
  to: Date,
): number {
  const fromStart = getOrgTodayRange(timezone, from).startUtc;
  const toStart = getOrgTodayRange(timezone, to).startUtc;
  return Math.round(
    (new Date(toStart).getTime() - new Date(fromStart).getTime()) /
      (24 * 3600 * 1000),
  );
}

/**
 * §5: deterministic, explainable attention rules — no fake score. Every
 * reason is derivable from real columns only; `level` is the highest level
 * among `reasons`, and `reasons` always lists every applicable one (never
 * just the highest) so the UI can show the real "why."
 */
/** "today" / "tomorrow" / "in N days" — never "in 0 days" or "in 1 days". */
export function relativeDayLabel(daysAway: number): string {
  if (daysAway === 0) return "today";
  if (daysAway === 1) return "tomorrow";
  return `in ${daysAway} days`;
}

export function computeAttention(input: {
  timezone: string;
  overdueActions: OpenCallRecordSummary[];
  blockers: OpenCallRecordSummary[];
  dueTodayOrSoonCount: number;
  serviceEndDaysAway: number | null;
  hasUnresolvedFromPriorMeetingForTodayCall: { callType: string | null } | null;
  nextCall: PortfolioCallSummary | null;
  pendingTruthCount: number;
  failedIntelligenceCount: number;
  now: Date;
}): CustomerAttention {
  const reasons: AttentionReason[] = [];

  if (input.overdueActions.length > 0) {
    const earliest = input.overdueActions.reduce((a, b) =>
      (a.dueAt ?? "") < (b.dueAt ?? "") ? a : b,
    );
    const daysOverdue = earliest.dueAt
      ? calendarDayOffset(input.timezone, new Date(earliest.dueAt), input.now)
      : null;
    reasons.push({
      code: "overdue_action",
      level: "high",
      label:
        input.overdueActions.length === 1
          ? `${earliest.description}${daysOverdue !== null && daysOverdue > 0 ? ` — overdue by ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}` : " — overdue"}`
          : `${input.overdueActions.length} overdue actions`,
    });
  }

  if (input.blockers.length > 0) {
    reasons.push({
      code: "unresolved_blocker",
      level: "high",
      label:
        input.blockers.length === 1
          ? `Unresolved blocker: ${input.blockers[0]?.description}`
          : `${input.blockers.length} unresolved blockers`,
    });
  }

  if (
    input.serviceEndDaysAway !== null &&
    input.serviceEndDaysAway <= SERVICE_END_HIGH_WINDOW_DAYS
  ) {
    reasons.push({
      code: "service_end_soon",
      level: "high",
      label: `Service period ends ${relativeDayLabel(input.serviceEndDaysAway)}`,
    });
  } else if (
    input.serviceEndDaysAway !== null &&
    input.serviceEndDaysAway <= SERVICE_END_MEDIUM_WINDOW_DAYS
  ) {
    reasons.push({
      code: "service_end_soon",
      level: "medium",
      label: `Service period ends ${relativeDayLabel(input.serviceEndDaysAway)}`,
    });
  }

  if (input.hasUnresolvedFromPriorMeetingForTodayCall) {
    const label = input.hasUnresolvedFromPriorMeetingForTodayCall.callType
      ? (CALL_TYPE_LABEL[
          input.hasUnresolvedFromPriorMeetingForTodayCall.callType
        ] ?? input.hasUnresolvedFromPriorMeetingForTodayCall.callType)
      : "Call";
    reasons.push({
      code: "call_today_unresolved_commitment",
      level: "high",
      label: `${label} today with an unresolved item from the last call`,
    });
  }

  if (input.dueTodayOrSoonCount > 0) {
    reasons.push({
      code: "due_soon_action",
      level: "medium",
      label: `${input.dueTodayOrSoonCount} action${input.dueTodayOrSoonCount === 1 ? "" : "s"} due within ${DUE_SOON_WINDOW_DAYS} days`,
    });
  }

  if (input.nextCall) {
    const daysAway = calendarDayOffset(
      input.timezone,
      input.now,
      new Date(input.nextCall.scheduledAt),
    );
    if (daysAway >= 0 && daysAway <= CALL_SOON_WINDOW_DAYS) {
      const label = input.nextCall.callType
        ? (CALL_TYPE_LABEL[input.nextCall.callType] ?? input.nextCall.callType)
        : "Call";
      reasons.push({
        code: "call_soon",
        level: "medium",
        label: `${label} call ${relativeDayLabel(daysAway)}`,
      });
    }
  }

  if (input.pendingTruthCount > 0) {
    reasons.push({
      code: "pending_truth_change",
      level: "medium",
      label: `${input.pendingTruthCount} pending customer truth change${input.pendingTruthCount === 1 ? "" : "s"} awaiting review`,
    });
  }

  // Restores M11's "failed intelligence processing" operational signal,
  // dropped (unintentionally) when M12 rewrote /home — but as a real,
  // explainable attention reason on the affected customer instead of a
  // standalone portfolio-wide banner, matching this milestone's model:
  // an AM missing a recap/actions/truth-updates for a specific customer
  // because its extraction failed is exactly the kind of per-customer
  // operational gap this section exists to surface.
  if (input.failedIntelligenceCount > 0) {
    reasons.push({
      code: "ai_processing_failed",
      level: "medium",
      label: `${input.failedIntelligenceCount} call${input.failedIntelligenceCount === 1 ? "" : "s"} failed intelligence processing`,
    });
  }

  const level: AttentionLevel = reasons.some((r) => r.level === "high")
    ? "high"
    : reasons.length > 0
      ? "medium"
      : "normal";

  return { level, reasons };
}

/**
 * §4/§10: the real AM portfolio composition — a fixed, small number of
 * batched queries regardless of portfolio size (never a per-customer
 * loop). `call_records` results are exactly whatever the caller's own RLS
 * permits (§2 correction: `call_records` visibility is meeting-scoped, not
 * customer-scoped — this function never claims to return literally every
 * open item for a customer beyond what RLS actually grants).
 */
export async function getPortfolioOverview(
  supabase: AppSupabaseClient,
  organizationId: string,
): Promise<PortfolioCustomerRow[]> {
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError) throw orgError;
  const timezone = org?.timezone ?? "UTC";
  const now = new Date();
  const today = getOrgTodayRange(timezone, now);

  const { data: customerRows, error: customersError } = await supabase
    .from("customers")
    .select("id, name, lifecycle_stage")
    .order("name", { ascending: true });
  if (customersError) throw customersError;
  const customers = customerRows ?? [];
  if (customers.length === 0) return [];
  const customerIds = customers.map((c) => c.id);

  const [
    schedulerRes,
    meetingsRes,
    callRecordsRes,
    truthRes,
    snapshotsRes,
    failedIntelligenceRes,
  ] = await Promise.all([
    supabase
      .from("scheduler_calls")
      .select(
        "customer_id, canonical_call_type, scheduled_at, external_status, meeting_id",
      )
      .in("customer_id", customerIds),
    supabase
      .from("meetings")
      .select("id, customer_id, scheduled_start")
      .in("customer_id", customerIds),
    supabase
      .from("call_records")
      .select(
        "id, customer_id, meeting_id, record_type, status, description, due_at, completed_at",
      )
      .in("customer_id", customerIds),
    supabase
      .from("customer_truth_facts")
      .select("customer_id, status, confirmed_at")
      .in("customer_id", customerIds)
      .in("status", ["proposed", "confirmed"]),
    supabase
      .from("customer_context_snapshots")
      .select("customer_id, normalized_data, created_at")
      .in("customer_id", customerIds)
      .order("created_at", { ascending: false }),
    // Restores M11's "failed intelligence processing" signal (§ comment
    // on computeAttention below) — RLS on ai_runs is meeting-scoped, same
    // as every other query here, so this returns only what this AM (or
    // manager/admin) can already see; the meeting_id -> customer_id
    // cross-reference below is defense-in-depth, not the real boundary.
    supabase.from("ai_runs").select("id, meeting_id").eq("status", "failed"),
  ]);
  if (schedulerRes.error) throw schedulerRes.error;
  if (meetingsRes.error) throw meetingsRes.error;
  if (callRecordsRes.error) throw callRecordsRes.error;
  if (truthRes.error) throw truthRes.error;
  if (snapshotsRes.error) throw snapshotsRes.error;
  if (failedIntelligenceRes.error) throw failedIntelligenceRes.error;

  const meetingStartById = new Map<string, string>();
  const meetingIdsByCustomer = new Map<string, string[]>();
  for (const m of meetingsRes.data ?? []) {
    meetingStartById.set(m.id, m.scheduled_start);
    const list = meetingIdsByCustomer.get(m.customer_id ?? "") ?? [];
    if (m.customer_id) {
      list.push(m.id);
      meetingIdsByCustomer.set(m.customer_id, list);
    }
  }

  const failedIntelligenceMeetingIds = new Set(
    (failedIntelligenceRes.data ?? []).map((r) => r.meeting_id),
  );

  const schedulerByCustomer = new Map<string, typeof schedulerRes.data>();
  for (const row of schedulerRes.data ?? []) {
    const list = schedulerByCustomer.get(row.customer_id) ?? [];
    list.push(row);
    schedulerByCustomer.set(row.customer_id, list);
  }

  const callRecordsByCustomer = new Map<string, typeof callRecordsRes.data>();
  for (const row of callRecordsRes.data ?? []) {
    if (!row.customer_id) continue;
    const list = callRecordsByCustomer.get(row.customer_id) ?? [];
    list.push(row);
    callRecordsByCustomer.set(row.customer_id, list);
  }

  const pendingTruthCountByCustomer = new Map<string, number>();
  const lastConfirmedAtByCustomer = new Map<string, string>();
  for (const fact of truthRes.data ?? []) {
    if (fact.status === "proposed") {
      pendingTruthCountByCustomer.set(
        fact.customer_id,
        (pendingTruthCountByCustomer.get(fact.customer_id) ?? 0) + 1,
      );
    } else if (fact.status === "confirmed" && fact.confirmed_at) {
      const current = lastConfirmedAtByCustomer.get(fact.customer_id);
      if (!current || fact.confirmed_at > current) {
        lastConfirmedAtByCustomer.set(fact.customer_id, fact.confirmed_at);
      }
    }
  }

  const serviceEndByCustomer = new Map<string, string | null>();
  const seenSnapshotCustomer = new Set<string>();
  for (const snap of snapshotsRes.data ?? []) {
    if (seenSnapshotCustomer.has(snap.customer_id)) continue;
    seenSnapshotCustomer.add(snap.customer_id);
    const normalized = snap.normalized_data as unknown as NormalizedCrmBaseline;
    serviceEndByCustomer.set(
      snap.customer_id,
      normalized?.context?.service_end ?? null,
    );
  }

  return customers.map((customer) => {
    // Codex Pass 2 (BLOCKING, fixed): `RESCHEDULED` is this real scheduler
    // API's actual "this row is stale" status (documented, verified-against-
    // live-data vocabulary: SCHEDULED/COMPLETED/MISSED_BY_AM/NOT_PICKED/
    // RESCHEDULED — `scheduler_calls_table.sql:44`) — a rescheduled row's
    // own `scheduled_at` no longer represents a real call and must never
    // count as "today," "last call," or trigger the
    // call_today_unresolved_commitment attention rule.
    const schedulerRows = (schedulerByCustomer.get(customer.id) ?? []).filter(
      (r) => r.external_status !== "RESCHEDULED",
    );
    const upcoming = schedulerRows
      .filter(
        (r) =>
          r.scheduled_at > now.toISOString() &&
          r.external_status === "SCHEDULED",
      )
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
    const past = schedulerRows
      .filter((r) => r.scheduled_at <= now.toISOString())
      .sort((a, b) => b.scheduled_at.localeCompare(a.scheduled_at));
    const nextCall: PortfolioCallSummary | null = upcoming[0]
      ? {
          callType: upcoming[0].canonical_call_type,
          scheduledAt: upcoming[0].scheduled_at,
          meetingId: upcoming[0].meeting_id,
        }
      : null;
    const lastCall: PortfolioCallSummary | null = past[0]
      ? {
          callType: past[0].canonical_call_type,
          scheduledAt: past[0].scheduled_at,
          meetingId: past[0].meeting_id,
        }
      : null;
    const todaysCallRows = schedulerRows.filter(
      (r) => r.scheduled_at >= today.startUtc && r.scheduled_at <= today.endUtc,
    );
    const todaysCalls: PortfolioCallSummary[] = todaysCallRows.map((r) => ({
      callType: r.canonical_call_type,
      scheduledAt: r.scheduled_at,
      meetingId: r.meeting_id,
    }));
    const isCallToday = todaysCallRows.length > 0;

    const records = callRecordsByCustomer.get(customer.id) ?? [];
    const openRecords = records.filter((r) => r.status === "detected");
    const overdueActions: OpenCallRecordSummary[] = openRecords
      .filter(
        (r) =>
          r.record_type !== "blocker" &&
          r.due_at &&
          r.due_at < now.toISOString(),
      )
      .map((r) => ({
        id: r.id,
        description: r.description,
        recordType: r.record_type,
        dueAt: r.due_at,
      }));
    const dueTodayOrSoon = openRecords.filter(
      (r) =>
        r.record_type !== "blocker" &&
        r.due_at &&
        r.due_at >= now.toISOString() &&
        r.due_at <=
          new Date(
            now.getTime() + DUE_SOON_WINDOW_DAYS * 24 * 3600 * 1000,
          ).toISOString(),
    );
    const dueTodayActions = dueTodayOrSoon.filter(
      (r) => r.due_at! >= today.startUtc && r.due_at! <= today.endUtc,
    );
    const blockers: OpenCallRecordSummary[] = openRecords
      .filter((r) => r.record_type === "blocker")
      .map((r) => ({
        id: r.id,
        description: r.description,
        recordType: r.record_type,
        dueAt: r.due_at,
      }));

    let priorUnresolvedForTodayCall: { callType: string | null } | null = null;
    if (isCallToday) {
      const hasPriorOpenItem = openRecords.some((r) => {
        const meetingStart = r.meeting_id
          ? meetingStartById.get(r.meeting_id)
          : null;
        return meetingStart && meetingStart < today.startUtc;
      });
      if (hasPriorOpenItem) {
        priorUnresolvedForTodayCall = {
          callType: todaysCallRows[0]?.canonical_call_type ?? null,
        };
      }
    }

    const lastCompletedAt = records
      .filter((r) => r.status === "completed" && r.completed_at)
      .reduce<string | null>(
        (max, r) => (!max || r.completed_at! > max ? r.completed_at! : max),
        null,
      );
    const lastConfirmedAt = lastConfirmedAtByCustomer.get(customer.id) ?? null;
    const lastMeaningfulUpdateAt =
      lastCompletedAt && lastConfirmedAt
        ? lastCompletedAt > lastConfirmedAt
          ? lastCompletedAt
          : lastConfirmedAt
        : (lastCompletedAt ?? lastConfirmedAt);

    const serviceEnd = serviceEndByCustomer.get(customer.id) ?? null;
    const serviceEndDaysAway = serviceEnd
      ? calendarDayOffset(timezone, now, new Date(serviceEnd))
      : null;
    const pendingTruthCount = pendingTruthCountByCustomer.get(customer.id) ?? 0;
    const failedIntelligenceCount = (
      meetingIdsByCustomer.get(customer.id) ?? []
    ).filter((meetingId) => failedIntelligenceMeetingIds.has(meetingId)).length;

    const attention = computeAttention({
      timezone,
      overdueActions,
      blockers,
      dueTodayOrSoonCount: dueTodayOrSoon.length,
      serviceEndDaysAway:
        serviceEndDaysAway !== null && serviceEndDaysAway >= 0
          ? serviceEndDaysAway
          : null,
      hasUnresolvedFromPriorMeetingForTodayCall: priorUnresolvedForTodayCall,
      nextCall,
      pendingTruthCount,
      failedIntelligenceCount,
      now,
    });

    return {
      customerId: customer.id,
      name: customer.name,
      lifecycleStage: customer.lifecycle_stage,
      nextCall,
      lastCall,
      isCallToday,
      todaysCalls,
      openActionCount: openRecords.filter((r) => r.record_type !== "blocker")
        .length,
      overdueActionCount: overdueActions.length,
      dueTodayActionCount: dueTodayActions.length,
      dueSoonActionCount: dueTodayOrSoon.length - dueTodayActions.length,
      openBlockerCount: blockers.length,
      pendingTruthCount,
      serviceEnd,
      serviceEndDaysAway,
      lastMeaningfulUpdateAt,
      attention,
    };
  });
}

export interface ActionQueueItem {
  id: string;
  recordType: string;
  description: string;
  dueAt: string | null;
  customerId: string | null;
}

export interface PortfolioActionQueue {
  overdue: ActionQueueItem[];
  dueToday: ActionQueueItem[];
  dueSoon: ActionQueueItem[];
}

const ACTION_QUEUE_LIMIT = 30;

/**
 * Codex-independent-review correctness fix: the home page previously ran
 * ONE query (`status='detected'`, ordered by due_at ascending, capped at
 * 30) covering overdue AND due-today AND due-soon items together. A large
 * overdue backlog (>30 stale items, which sort first) could push every
 * genuinely near-term item past the cutoff, hiding the most actionable
 * work. Fixed by giving "overdue" and "due today or soon" their OWN
 * independent queries, each with its own cap — a large overdue backlog
 * can never crowd out near-term items again, because they're no longer
 * competing for the same limit. Blockers are excluded (same convention as
 * `overdueActions`/`dueTodayOrSoon` in `getPortfolioOverview` above) since
 * they already have their own attention representation
 * (`unresolved_blocker` reason, `openBlockerCount`) — showing a due-dated
 * blocker here too would double-count it.
 */
export async function getPortfolioActionQueue(
  supabase: AppSupabaseClient,
  timezone: string,
  now: Date = new Date(),
): Promise<PortfolioActionQueue> {
  const today = getOrgTodayRange(timezone, now);
  const sevenDaysFromNowIso = new Date(
    now.getTime() + 7 * 24 * 3600 * 1000,
  ).toISOString();

  const SELECT_COLUMNS = "id, record_type, description, due_at, customer_id";

  const [overdueRes, dueSoonRes] = await Promise.all([
    supabase
      .from("call_records")
      .select(SELECT_COLUMNS)
      .eq("status", "detected")
      .neq("record_type", "blocker")
      .lt("due_at", today.startUtc)
      .order("due_at", { ascending: true })
      .limit(ACTION_QUEUE_LIMIT),
    supabase
      .from("call_records")
      .select(SELECT_COLUMNS)
      .eq("status", "detected")
      .neq("record_type", "blocker")
      .gte("due_at", today.startUtc)
      .lte("due_at", sevenDaysFromNowIso)
      .order("due_at", { ascending: true })
      .limit(ACTION_QUEUE_LIMIT),
  ]);
  if (overdueRes.error) throw overdueRes.error;
  if (dueSoonRes.error) throw dueSoonRes.error;

  const toItem = (r: {
    id: string;
    record_type: string;
    description: string;
    due_at: string | null;
    customer_id: string | null;
  }): ActionQueueItem => ({
    id: r.id,
    recordType: r.record_type,
    description: r.description,
    dueAt: r.due_at,
    customerId: r.customer_id,
  });

  const overdue = (overdueRes.data ?? []).map(toItem);
  const dueSoonRows = (dueSoonRes.data ?? []).map(toItem);
  const dueToday = dueSoonRows.filter(
    (r) => r.dueAt !== null && r.dueAt <= today.endUtc,
  );
  const dueSoon = dueSoonRows.filter(
    (r) => r.dueAt !== null && r.dueAt > today.endUtc,
  );

  return { overdue, dueToday, dueSoon };
}
