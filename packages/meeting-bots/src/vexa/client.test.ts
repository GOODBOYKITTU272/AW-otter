import { describe, expect, it, vi } from "vitest";
import { VexaMeetingBotProvider } from "./client";
import { VexaAuthError, VexaRateLimitError } from "./errors";

const teamsUrl =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7B%7D";
const nativeMeetingId = "19:meeting_abc@thread.v2";
const providerBotId = `teams/${encodeURIComponent(nativeMeetingId)}`;

function response(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("VexaMeetingBotProvider", () => {
  it("sends the API key as a header, never as a query param", async () => {
    const fetchImpl = vi.fn(
      async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(201, {
          status: "requested",
          native_meeting_id: nativeMeetingId,
        }),
    );
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "secret-key" },
      fetchImpl,
    );

    await provider.createBot({
      meetingUrl: teamsUrl,
      idempotencyKey: "idem-1",
      botName: "AW Echo · Test",
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).not.toContain("secret-key");
    expect((init?.headers as Record<string, string>)["X-API-Key"]).toBe(
      "secret-key",
    );
  });

  it("posts meeting_url, idempotency key, and disabled transcription, and maps the response using the returned native_meeting_id", async () => {
    const fetchImpl = vi.fn(
      async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(201, { status: "active", native_meeting_id: nativeMeetingId }),
    );
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test/", apiKey: "key" },
      fetchImpl,
    );

    const result = await provider.createBot({
      meetingUrl: teamsUrl,
      idempotencyKey: "idem-1",
      botName: "AW Echo · Test",
      // botAvatarUrl: "https://echo.applywizz.ai/logo.png", // PREPARED: Infrastructure ready for when Vexa enables avatar API
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.vexa.test/bots");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      "idem-1",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      platform: "teams",
      meeting_url: teamsUrl,
      bot_name: "AW Echo · Test",
      transcribe_enabled: false,
      // Avatar URL not included until Vexa API supports it (currently 404)
    });
    expect(result).toEqual({
      providerBotId,
      status: "joined",
      raw: { status: "active", native_meeting_id: nativeMeetingId },
    });
  });

  it("throws if the response is missing native_meeting_id", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(201, { status: "requested" }),
      ),
    );

    await expect(
      provider.createBot({
        meetingUrl: teamsUrl,
        idempotencyKey: "idem-1",
        botName: "AW Echo · Test",
      }),
    ).rejects.toThrow(/native_meeting_id/);
  });

  it("throws VexaAuthError on 401", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(401, { detail: "bad key" }),
      ),
    );

    await expect(
      provider.createBot({
        meetingUrl: teamsUrl,
        idempotencyKey: "idem-1",
        botName: "AW Echo · Test",
      }),
    ).rejects.toBeInstanceOf(VexaAuthError);
  });

  it("throws VexaRateLimitError on 429 with parsed Retry-After", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(429, {}, { "Retry-After": "45" }),
      ),
    );

    const call = provider.createBot({
      meetingUrl: teamsUrl,
      idempotencyKey: "idem-1",
      botName: "AW Echo · Test",
    });
    await expect(call).rejects.toBeInstanceOf(VexaRateLimitError);
    await expect(call).rejects.toMatchObject({ retryAfterSeconds: 45 });
  });

  it("normalizes unknown status strings to pending", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(200, {
          running: [
            {
              native_meeting_id: nativeMeetingId,
              status: "new_provider_state",
            },
          ],
        }),
      ),
    );

    await expect(provider.getBotStatus(providerBotId)).resolves.toEqual({
      status: "pending",
      raw: { native_meeting_id: nativeMeetingId, status: "new_provider_state" },
      joinedAt: undefined,
      leftAt: undefined,
      failureReason: undefined,
      rawStatus: "new_provider_state",
    });
  });

  it("normalizes requested status to scheduled on creation", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async () =>
        response(201, {
          status: "requested",
          native_meeting_id: nativeMeetingId,
        }),
      ),
    );

    const result = await provider.createBot({
      meetingUrl: teamsUrl,
      idempotencyKey: "idem-req",
      botName: "AW Echo · Test",
    });
    expect(result.status).toBe("scheduled");
    expect(result.providerBotId).toBe(providerBotId);
  });

  it("checks status via GET /bots/status and matches by native_meeting_id", async () => {
    const fetchImpl = vi.fn(
      async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(200, {
          running: [
            {
              native_meeting_id: nativeMeetingId,
              status: "awaiting_admission",
            },
          ],
        }),
    );
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      fetchImpl,
    );

    const result = await provider.getBotStatus(providerBotId);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.vexa.test/bots/status");
    expect(init?.method).toBe("GET");
    expect(result.status).toBe("joining");
  });

  it("treats a bot no longer in the running list as completed", async () => {
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(200, { running: [] }),
      ),
    );

    await expect(provider.getBotStatus(providerBotId)).resolves.toEqual({
      status: "completed",
      raw: { running: [] },
    });
  });

  it("calls the Vexa stop endpoint on cancel", async () => {
    const fetchImpl = vi.fn(
      async (_input?: string | URL | Request, _init?: RequestInit) =>
        response(200, { status: "stopping" }),
    );
    const provider = new VexaMeetingBotProvider(
      { baseUrl: "https://api.vexa.test", apiKey: "key" },
      fetchImpl,
    );

    await provider.cancelBot({ providerBotId });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.vexa.test/bots/${providerBotId}`);
    expect(init?.method).toBe("DELETE");
  });
});
