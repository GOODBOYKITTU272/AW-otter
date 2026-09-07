/**
 * Our own normalized bot lifecycle — matches public.bot_status exactly
 * (see 20260907030001_meeting_bot_tables.sql for why this is a deliberate
 * V1 collapse of the richer provider-normalized vocabulary the locked
 * blueprint describes). A provider adapter's job is to map its own
 * states onto exactly these seven values — nothing provider-specific
 * (Vexa's own status strings, its bot ids, its response shapes) crosses
 * this boundary into core domain/UI code.
 */
export type BotStatus =
  | "pending"
  | "scheduled"
  | "joining"
  | "joined"
  | "completed"
  | "cancelled"
  | "failed";

export interface CreateBotInput {
  /** The Teams join URL — the only thing a provider needs to find the meeting. */
  meetingUrl: string;
  /** Client-supplied dedup token: a retried createBot call for the same key must never create a second bot. */
  idempotencyKey: string;
  /** Display name the bot shows as inside the meeting — "ApplyWizz Meeting Assistant". */
  botName: string;
}

export interface CreateBotResult {
  providerBotId: string;
  status: BotStatus;
  /** Raw provider response, parked for diagnostics — never surfaced past the domain layer. */
  raw: unknown;
}

export interface CancelBotInput {
  providerBotId: string;
}

export interface BotStatusResult {
  status: BotStatus;
  joinedAt?: string;
  leftAt?: string;
  failureReason?: string;
  raw: unknown;
}

/**
 * TRD §7's locked contract, minus getTranscript/getRecording — those are
 * M7's concern (transcript/recording artifacts), deliberately not modeled
 * here yet ("Keep M6 independent from transcript/AI work").
 */
export interface MeetingBotProvider {
  readonly name: string;
  createBot(input: CreateBotInput): Promise<CreateBotResult>;
  cancelBot(input: CancelBotInput): Promise<void>;
  getBotStatus(providerBotId: string): Promise<BotStatusResult>;
}
