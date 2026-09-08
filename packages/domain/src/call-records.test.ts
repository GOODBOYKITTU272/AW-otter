import { describe, expect, it, vi } from "vitest";
import { assignCallRecordOwner, resolveCallRecord } from "./call-records";
import type { AppSupabaseClient } from "./call-records";

function fakeSupabase(response: { data: unknown; error: unknown }) {
  const rpc = vi.fn(async () => response);
  return { client: { rpc } as unknown as AppSupabaseClient, rpc };
}

describe("resolveCallRecord", () => {
  it("calls resolve_call_record with the expected args and returns the row", async () => {
    const row = { id: "rec1", status: "completed" };
    const { client, rpc } = fakeSupabase({ data: row, error: null });

    const result = await resolveCallRecord(client, "rec1", "completed", "done");

    expect(rpc).toHaveBeenCalledWith("resolve_call_record", {
      p_record_id: "rec1",
      p_resolution: "completed",
      p_note: "done",
    });
    expect(result).toEqual(row);
  });

  it("passes null when no note is given", async () => {
    const { client, rpc } = fakeSupabase({ data: { id: "rec1" }, error: null });
    await resolveCallRecord(client, "rec1", "cancelled");
    expect(rpc).toHaveBeenCalledWith("resolve_call_record", {
      p_record_id: "rec1",
      p_resolution: "cancelled",
      p_note: null,
    });
  });

  it("throws the RPC error rather than swallowing it", async () => {
    const { client } = fakeSupabase({ data: null, error: new Error("not authorized") });
    await expect(resolveCallRecord(client, "rec1", "completed")).rejects.toThrow(
      "not authorized",
    );
  });
});

describe("assignCallRecordOwner", () => {
  it("calls assign_call_record_owner with the expected args and returns the row", async () => {
    const row = { id: "rec1", owner_membership_id: "mem1" };
    const { client, rpc } = fakeSupabase({ data: row, error: null });

    const result = await assignCallRecordOwner(client, "rec1", "mem1", "2026-09-10T00:00:00Z");

    expect(rpc).toHaveBeenCalledWith("assign_call_record_owner", {
      p_record_id: "rec1",
      p_owner_membership_id: "mem1",
      p_due_at: "2026-09-10T00:00:00Z",
    });
    expect(result).toEqual(row);
  });

  it("throws the RPC error rather than swallowing it", async () => {
    const { client } = fakeSupabase({
      data: null,
      error: new Error("must belong to the caller's own organization"),
    });
    await expect(assignCallRecordOwner(client, "rec1", "mem-other-org")).rejects.toThrow(
      "must belong to the caller's own organization",
    );
  });
});
