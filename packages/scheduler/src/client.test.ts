import { describe, expect, it, vi } from "vitest";
import { listCalls } from "./client";
import {
  SchedulerApiError,
  SchedulerMalformedResponseError,
  SchedulerProviderMisuseError,
  SchedulerTimeoutError,
} from "./errors";

function fakeFetch(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const VALID_ROW = {
  id: "call-1",
  lead_id: "AWL-1",
  client_name: "Client One",
  client_email: "client1@example.com",
  am_email: "SARIKA@applywizz.com",
  type: "DISCOVERY",
  scheduled_at: "2026-09-08T05:45:00+05:30",
  status: "SCHEDULED",
};

describe("listCalls", () => {
  it("normalizes a valid response and lowercases am_email", async () => {
    const result = await listCalls(
      "https://scheduler.test",
      { amEmail: "sarika@applywizz.com" },
      fakeFetch(200, { success: true, calls: [VALID_ROW] }),
    );
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.amEmail).toBe("sarika@applywizz.com");
    expect(result.calls[0]?.leadId).toBe("AWL-1");
    expect(result.skippedInvalidRows).toBe(0);
  });

  it("refuses an empty am_email without making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SchedulerProviderMisuseError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses am_email="ALL" (case-insensitive) without making a request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "aLL" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SchedulerProviderMisuseError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws SchedulerMalformedResponseError when the envelope shape is wrong", async () => {
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "sarika@applywizz.com" },
        fakeFetch(200, { calls: [VALID_ROW] }), // missing success:true
      ),
    ).rejects.toBeInstanceOf(SchedulerMalformedResponseError);
  });

  it("throws SchedulerMalformedResponseError when calls is not an array", async () => {
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "sarika@applywizz.com" },
        fakeFetch(200, { success: true, calls: "nope" }),
      ),
    ).rejects.toBeInstanceOf(SchedulerMalformedResponseError);
  });

  it("skips individual rows missing a required identity field instead of failing the whole batch", async () => {
    const result = await listCalls(
      "https://scheduler.test",
      { amEmail: "sarika@applywizz.com" },
      fakeFetch(200, {
        success: true,
        calls: [VALID_ROW, { id: "call-2" /* missing lead_id, type, etc */ }],
      }),
    );
    expect(result.calls).toHaveLength(1);
    expect(result.skippedInvalidRows).toBe(1);
  });

  it("throws SchedulerApiError for a non-2xx, non-5xx response (no retry)", async () => {
    const fetchImpl = vi.fn(fakeFetch(404, { error: "not found" }));
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "sarika@applywizz.com" },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(SchedulerApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once on a 5xx and succeeds if the retry is healthy", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 503 });
      }
      return new Response(
        JSON.stringify({ success: true, calls: [VALID_ROW] }),
        { status: 200 },
      );
    });
    const result = await listCalls(
      "https://scheduler.test",
      { amEmail: "sarika@applywizz.com" },
      fetchImpl,
    );
    expect(result.calls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws SchedulerApiError if the 5xx retry also fails", async () => {
    const fetchImpl = vi.fn(fakeFetch(500, { error: "boom" }));
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "sarika@applywizz.com" },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(SchedulerApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("times out and throws SchedulerTimeoutError, then retries once", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }
      return new Response(
        JSON.stringify({ success: true, calls: [VALID_ROW] }),
        { status: 200 },
      );
    });
    const result = await listCalls(
      "https://scheduler.test",
      { amEmail: "sarika@applywizz.com" },
      fetchImpl as unknown as typeof fetch,
      20,
    );
    expect(result.calls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a genuine timeout twice — a second timeout still throws", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      });
    });
    await expect(
      listCalls(
        "https://scheduler.test",
        { amEmail: "sarika@applywizz.com" },
        fetchImpl as unknown as typeof fetch,
        20,
      ),
    ).rejects.toBeInstanceOf(SchedulerTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("builds the query string with all supported params", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ success: true, calls: [] }), {
        status: 200,
      });
    });
    await listCalls(
      "https://scheduler.test",
      {
        amEmail: "sarika@applywizz.com",
        type: "DISCOVERY",
        status: "SCHEDULED",
        from: "2026-09-01",
        to: "2026-09-08",
        leadId: "AWL-1",
        orderBy: "created_at",
      },
      fetchImpl as unknown as typeof fetch,
    );
    const parsed = new URL(capturedUrl);
    expect(parsed.pathname).toBe("/api/scheduler/calls");
    expect(parsed.searchParams.get("am_email")).toBe("sarika@applywizz.com");
    expect(parsed.searchParams.get("type")).toBe("DISCOVERY");
    expect(parsed.searchParams.get("status")).toBe("SCHEDULED");
    expect(parsed.searchParams.get("from")).toBe("2026-09-01");
    expect(parsed.searchParams.get("to")).toBe("2026-09-08");
    expect(parsed.searchParams.get("lead_id")).toBe("AWL-1");
    expect(parsed.searchParams.get("order_by")).toBe("created_at");
  });
});
