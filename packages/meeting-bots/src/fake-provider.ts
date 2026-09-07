import type {
  BotStatusResult,
  CancelBotInput,
  CreateBotInput,
  CreateBotResult,
  MeetingBotProvider,
} from "./types";

/**
 * In-memory MeetingBotProvider for tests and local verification without
 * real Vexa credentials (locked implementation plan step 52: "Implement
 * fake provider for tests"). Deterministic, idempotency-aware (a repeated
 * createBot call with the same idempotencyKey returns the SAME bot, never
 * a second one — the one thing a real provider's own dedup would also
 * have to guarantee), and lets tests drive a bot through its full
 * lifecycle by calling advanceTo() directly.
 */
export class FakeMeetingBotProvider implements MeetingBotProvider {
  readonly name = "fake";

  private readonly botsByIdempotencyKey = new Map<string, CreateBotResult>();
  private readonly statusByBotId = new Map<string, BotStatusResult>();

  async createBot(input: CreateBotInput): Promise<CreateBotResult> {
    const existing = this.botsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;

    // Globally unique, not per-instance-incrementing — a real provider's
    // bot ids are unique across every caller, not just within one client
    // instance, and meeting_bot_jobs.provider_bot_id is a real, global
    // unique constraint. A counter starting at 1 in every fresh instance
    // would collide the moment two provider instances (e.g. two test
    // files, or two worker processes) shared the same database.
    const providerBotId = `fake-bot-${crypto.randomUUID()}`;
    const result: CreateBotResult = {
      providerBotId,
      status: "scheduled",
      raw: { input },
    };
    this.botsByIdempotencyKey.set(input.idempotencyKey, result);
    this.statusByBotId.set(providerBotId, { status: "scheduled", raw: {} });
    return result;
  }

  async cancelBot(input: CancelBotInput): Promise<void> {
    const current = this.statusByBotId.get(input.providerBotId);
    if (!current) return;
    this.statusByBotId.set(input.providerBotId, {
      ...current,
      status: "cancelled",
    });
  }

  async getBotStatus(providerBotId: string): Promise<BotStatusResult> {
    const current = this.statusByBotId.get(providerBotId);
    if (!current)
      throw new Error(`Fake provider has no bot with id ${providerBotId}.`);
    return current;
  }

  /** Test-only: advance a fake bot to a specific status, e.g. to simulate it joining or completing. */
  advanceTo(
    providerBotId: string,
    status: BotStatusResult["status"],
    extra: Partial<BotStatusResult> = {},
  ): void {
    const current = this.statusByBotId.get(providerBotId) ?? {
      status: "scheduled",
      raw: {},
    };
    this.statusByBotId.set(providerBotId, { ...current, ...extra, status });
  }
}
