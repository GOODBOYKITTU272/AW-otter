import { describe, it, expect } from "vitest";
import { normalizeVexaStatus, isLobbyWaitingStatus } from "./normalize";

describe("normalizeVexaStatus", () => {
  it("maps awaiting_admission to joining", () => {
    expect(normalizeVexaStatus("awaiting_admission")).toBe("joining");
  });

  it("maps waiting_for_admission to joining", () => {
    expect(normalizeVexaStatus("waiting_for_admission")).toBe("joining");
  });

  it("maps needs_help to joining", () => {
    expect(normalizeVexaStatus("needs_help")).toBe("joining");
  });

  it("maps joining to joining", () => {
    expect(normalizeVexaStatus("joining")).toBe("joining");
  });

  it("maps active to joined", () => {
    expect(normalizeVexaStatus("active")).toBe("joined");
  });

  it("maps in_call_recording to joined", () => {
    expect(normalizeVexaStatus("in_call_recording")).toBe("joined");
  });
});

describe("isLobbyWaitingStatus", () => {
  it("returns true for awaiting_admission", () => {
    expect(isLobbyWaitingStatus("awaiting_admission")).toBe(true);
  });

  it("returns true for waiting_for_admission", () => {
    expect(isLobbyWaitingStatus("waiting_for_admission")).toBe(true);
  });

  it("returns true for needs_help", () => {
    expect(isLobbyWaitingStatus("needs_help")).toBe(true);
  });

  it("returns true for case-insensitive AWAITING_ADMISSION", () => {
    expect(isLobbyWaitingStatus("AWAITING_ADMISSION")).toBe(true);
  });

  it("returns false for joining", () => {
    expect(isLobbyWaitingStatus("joining")).toBe(false);
  });

  it("returns false for active", () => {
    expect(isLobbyWaitingStatus("active")).toBe(false);
  });

  it("returns false for joined", () => {
    expect(isLobbyWaitingStatus("joined")).toBe(false);
  });

  it("returns false for in_call_recording", () => {
    expect(isLobbyWaitingStatus("in_call_recording")).toBe(false);
  });

  it("returns false for completed", () => {
    expect(isLobbyWaitingStatus("completed")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isLobbyWaitingStatus(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isLobbyWaitingStatus(undefined)).toBe(false);
  });

  it("returns false for non-string value", () => {
    expect(isLobbyWaitingStatus(123)).toBe(false);
  });
});
