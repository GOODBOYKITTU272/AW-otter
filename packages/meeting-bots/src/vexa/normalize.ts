import type { BotStatus } from "../types";

export interface VexaMeetingIdentity {
  platform: "teams";
  nativeMeetingId: string;
}

export function normalizeVexaStatus(status: unknown): BotStatus {
  if (typeof status !== "string") return "pending";

  switch (status.toLowerCase()) {
    case "idle":
    case "pending":
      return "pending";
    case "requested":
    case "scheduled":
      return "scheduled";
    case "joining":
    case "awaiting_admission":
    case "waiting_for_admission":
    case "needs_help":
      return "joining";
    case "active":
    case "joined":
    case "in_call_recording":
    case "in_call_not_recording":
      return "joined";
    case "completed":
      return "completed";
    case "stopping":
    case "stopped":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

/**
 * Returns true if the raw Vexa status indicates the bot is waiting in the
 * Teams lobby for a human to admit it (not just "joining" network/handshake).
 * Phase-1 P0: this is the high-leverage distinction for CRM customer calls.
 */
export function isLobbyWaitingStatus(rawStatus: unknown): boolean {
  if (typeof rawStatus !== "string") return false;
  const lower = rawStatus.toLowerCase();
  return (
    lower === "awaiting_admission" ||
    lower === "waiting_for_admission" ||
    lower === "needs_help"
  );
}

export function encodeProviderBotId(identity: VexaMeetingIdentity): string {
  return `${identity.platform}/${encodeURIComponent(identity.nativeMeetingId)}`;
}

export function decodeProviderBotId(
  providerBotId: string,
): VexaMeetingIdentity {
  const [platform, encodedNativeMeetingId, ...rest] = providerBotId.split("/");
  if (platform !== "teams" || !encodedNativeMeetingId || rest.length > 0) {
    throw new Error("Invalid Vexa provider bot id.");
  }
  return {
    platform,
    nativeMeetingId: decodeURIComponent(encodedNativeMeetingId),
  };
}
