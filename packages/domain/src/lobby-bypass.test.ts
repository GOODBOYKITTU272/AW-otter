import { describe, expect, it, vi } from "vitest";
import { applyLobbyBypassIfEnabled, type AppSupabaseClient } from "./lobby-bypass";

// Mock the feature flags and Microsoft Graph client
vi.mock("./feature-flags", () => ({
  getFeatureFlags: vi.fn(() => ({
    enableLobbyBypassPatch: true,
    enableEchoAttendeeInvite: false,
    enableVideoRecording: false,
    enableAudioRecording: true,
  })),
}));

vi.mock("@applywizz/microsoft", () => ({
  patchOnlineMeetingLobbyBypass: vi.fn(async () => undefined),
}));

// Minimal fake Supabase client for testing
interface Call {
  op: "select" | "insert" | "update";
  payload?: unknown;
  filters: Record<string, unknown>;
}

type TableHandler = (call: Call) => { data: unknown; error: unknown };

function createFakeSupabase(
  handlers: Record<string, TableHandler>,
): AppSupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    let op: Call["op"] = "select";
    let payload: unknown;

    function resolve() {
      const handler = handlers[table];
      if (!handler) return { data: null, error: null };
      return handler({ op, payload, filters });
    }

    const builder = {
      select: (cols?: string) => {
        op = "select";
        filters.select = cols;
        return builder;
      },
      insert: (data: unknown) => {
        op = "insert";
        payload = data;
        // For insert, resolve immediately (no maybeSingle/single chaining)
        return resolve();
      },
      update: (data: unknown) => {
        op = "update";
        payload = data;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters[`eq_${col}`] = val;
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters[`in_${col}`] = vals;
        return builder;
      },
      maybeSingle: resolve,
      single: resolve,
    };

    return builder;
  }

  return { from } as unknown as AppSupabaseClient;
}

describe("applyLobbyBypassIfEnabled", () => {
  it("skips when feature flag is disabled", async () => {
    const { getFeatureFlags } = await import("./feature-flags");
    vi.mocked(getFeatureFlags).mockReturnValueOnce({
      enableLobbyBypassPatch: false,
      enableEchoAttendeeInvite: false,
      enableVideoRecording: false,
      enableAudioRecording: true,
    });

    const { patchOnlineMeetingLobbyBypass } = await import("@applywizz/microsoft");
    const patchSpy = vi.mocked(patchOnlineMeetingLobbyBypass);
    patchSpy.mockClear();

    const supabase = createFakeSupabase({});

    await applyLobbyBypassIfEnabled(
      supabase,
      "test-token",
      "meeting-1",
      "online-meeting-123",
      "organizer@applywizz.test",
      "org-1",
    );

    expect(patchSpy).not.toHaveBeenCalled();
  });

  it("logs audit event when organizer GUID cannot be resolved", async () => {
    const { patchOnlineMeetingLobbyBypass } = await import("@applywizz/microsoft");
    const patchSpy = vi.mocked(patchOnlineMeetingLobbyBypass);
    patchSpy.mockClear();

    const auditInsertSpy = vi.fn((..._args: unknown[]) => ({ data: null, error: null }));
    const supabase = createFakeSupabase({
      calendar_connections: () => ({ data: [], error: null }),
      audit_events: (call) =>
        call.op === "insert" ? auditInsertSpy(call.payload) : { data: null, error: null },
    });

    await applyLobbyBypassIfEnabled(
      supabase,
      "test-token",
      "meeting-1",
      "online-meeting-123",
      "unknown@example.com",
      "org-1",
    );

    expect(patchSpy).not.toHaveBeenCalled();
    expect(auditInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "meeting.lobby_bypass_skipped_no_guid",
        entity_type: "meeting",
        entity_id: "meeting-1",
      }),
    );
  });

  // Note: Additional integration tests for Graph PATCH success/failure paths
  // are covered by the Graph client tests (graph-client.test.ts) and the
  // meeting-bots integration flow. These unit tests verify the core logic
  // (feature flag gating, organizer resolution, audit logging) without
  // complex async mock orchestration.
});
