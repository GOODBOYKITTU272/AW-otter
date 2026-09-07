import type {
  BotStatusResult,
  CancelBotInput,
  CreateBotInput,
  CreateBotResult,
  MeetingBotProvider,
} from "../types";
import type { VexaEnv } from "./config";
import { normalizeVexaError } from "./errors";
import {
  decodeProviderBotId,
  encodeProviderBotId,
  normalizeVexaStatus,
  type VexaMeetingIdentity,
} from "./normalize";

// Shapes confirmed against docs.vexa.ai/api/meetings (2026-09): POST /bots
// accepts a full `meeting_url` directly ("settles host and passcode
// together") — no need to parse a native_meeting_id/passcode out of the
// URL ourselves. The response still echoes back `native_meeting_id` and
// `platform`, which is what DELETE /bots/{platform}/{native_meeting_id}
// (the documented cancel endpoint) actually needs — that's what
// providerBotId encodes, not a client-invented value.
interface RawVexaCreateResponse {
  id?: string | number;
  platform?: string;
  native_meeting_id?: string;
  status?: string;
}

interface RawVexaRunningBot {
  native_meeting_id?: string;
  status?: string;
  start_time?: string | null;
  end_time?: string | null;
  failure_stage?: string | null;
  completion_reason?: string | null;
}

interface RawVexaBotsStatusResponse {
  running?: RawVexaRunningBot[];
  running_bots?: RawVexaRunningBot[];
}

export class VexaMeetingBotProvider implements MeetingBotProvider {
  readonly name = "vexa";

  constructor(
    private readonly env: VexaEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createBot(input: CreateBotInput): Promise<CreateBotResult> {
    // meeting_url directly — Vexa "settles host and passcode together"
    // from the raw Teams join URL M4 already captured. transcribe_enabled
    // is explicitly false: M6 only schedules the bot, transcription is M7.
    const raw = await this.request<RawVexaCreateResponse>("/bots", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        platform: "teams",
        meeting_url: input.meetingUrl,
        bot_name: input.botName,
        transcribe_enabled: false,
      }),
    });

    if (!raw.native_meeting_id) {
      throw new Error(
        "Vexa create-bot response did not include native_meeting_id.",
      );
    }

    return {
      providerBotId: encodeProviderBotId({
        platform: "teams",
        nativeMeetingId: raw.native_meeting_id,
      }),
      status: normalizeVexaStatus(raw.status),
      raw,
    };
  }

  async cancelBot(input: CancelBotInput): Promise<void> {
    const identity = decodeProviderBotId(input.providerBotId);
    await this.request(`/bots/${this.pathKey(identity)}`, { method: "DELETE" });
  }

  async getBotStatus(providerBotId: string): Promise<BotStatusResult> {
    // Corrected against the real deployment during the M6 golden-path
    // test: GET /meetings/{meeting_id} takes Vexa's own internal numeric
    // id, NOT native_meeting_id (confirmed live — it 422s on a string).
    // GET /bots/status instead lists every currently-running bot by
    // native_meeting_id, which is exactly the identifier providerBotId
    // already carries — no need to also track Vexa's internal numeric id.
    // A bot that no longer appears here has left the running set, which
    // this V1 adapter treats as 'completed' (the common case — a meeting
    // that ran its course); a real "join never happened" failure is still
    // caught by the meeting_bot_jobs `next_retry_at`/timeout handling one
    // layer up, not by this call.
    const identity = decodeProviderBotId(providerBotId);
    const raw = await this.request<RawVexaBotsStatusResponse>("/bots/status", {
      method: "GET",
    });
    const bots = raw.running ?? raw.running_bots ?? [];
    const bot = bots.find(
      (b) => b.native_meeting_id === identity.nativeMeetingId,
    );

    if (!bot) {
      return { status: "completed", raw };
    }

    return {
      status: normalizeVexaStatus(bot.status),
      joinedAt: bot.start_time ?? undefined,
      leftAt: bot.end_time ?? undefined,
      failureReason: bot.completion_reason ?? bot.failure_stage ?? undefined,
      raw: bot,
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl()}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.env.apiKey,
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw normalizeVexaError(
        response.status,
        body,
        response.headers.get("retry-after"),
      );
    }
    return body as T;
  }

  private baseUrl(): string {
    return this.env.baseUrl.replace(/\/+$/, "");
  }

  private pathKey(identity: VexaMeetingIdentity): string {
    return `${identity.platform}/${encodeURIComponent(identity.nativeMeetingId)}`;
  }
}
