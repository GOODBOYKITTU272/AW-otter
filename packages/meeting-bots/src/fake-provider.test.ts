import { describe, expect, it } from "vitest";
import { FakeMeetingBotProvider } from "./fake-provider";

describe("FakeMeetingBotProvider", () => {
  it("creating a bot twice with the same idempotency key returns the same bot", async () => {
    const provider = new FakeMeetingBotProvider();
    const first = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "k1",
      botName: "ApplyWizz Meeting Assistant",
    });
    const second = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "k1",
      botName: "ApplyWizz Meeting Assistant",
    });
    expect(second.providerBotId).toBe(first.providerBotId);
  });

  it("different idempotency keys produce different bots", async () => {
    const provider = new FakeMeetingBotProvider();
    const first = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "k1",
      botName: "ApplyWizz Meeting Assistant",
    });
    const second = await provider.createBot({
      meetingUrl: "https://teams.example/y",
      idempotencyKey: "k2",
      botName: "ApplyWizz Meeting Assistant",
    });
    expect(second.providerBotId).not.toBe(first.providerBotId);
  });

  it("advanceTo lets a test drive the bot through its lifecycle", async () => {
    const provider = new FakeMeetingBotProvider();
    const { providerBotId } = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "k1",
      botName: "ApplyWizz Meeting Assistant",
    });
    provider.advanceTo(providerBotId, "joined", {
      joinedAt: "2026-01-01T00:00:00Z",
    });
    const status = await provider.getBotStatus(providerBotId);
    expect(status).toEqual({
      status: "joined",
      raw: {},
      joinedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("cancelBot moves the bot to cancelled", async () => {
    const provider = new FakeMeetingBotProvider();
    const { providerBotId } = await provider.createBot({
      meetingUrl: "https://teams.example/x",
      idempotencyKey: "k1",
      botName: "ApplyWizz Meeting Assistant",
    });
    await provider.cancelBot({ providerBotId });
    const status = await provider.getBotStatus(providerBotId);
    expect(status.status).toBe("cancelled");
  });

  it("getBotStatus throws for an unknown bot id", async () => {
    const provider = new FakeMeetingBotProvider();
    await expect(provider.getBotStatus("unknown")).rejects.toThrow(/no bot/i);
  });
});
