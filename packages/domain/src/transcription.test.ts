import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  EnglishNormalizationProvider,
  TranscriptionProvider,
} from "@applywizz/transcription";
import {
  enqueuePendingTranscriptions,
  processTranscriptionJob,
  processTranscriptionQueue,
  type AppSupabaseClient,
} from "./transcription";

const execFileAsync = promisify(execFile);

let syntheticAudioBytes: ArrayBuffer;
let scratchDir: string;

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "transcription-domain-test-"));
  const path = join(scratchDir, "synthetic.webm");
  await execFileAsync("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-t",
    "1",
    "-c:a",
    "libopus",
    path,
  ]);
  const buf = await readFile(path);
  syntheticAudioBytes = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  );
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
});

// --- Minimal stateful in-memory fake, same shape/reasoning as
// scheduler-linkage.test.ts's own fake (a static per-call handler can't
// represent this module's real upsert/claim/retry orchestration).
interface Row {
  [key: string]: unknown;
}

class FakeTable {
  rows: Row[] = [];
  private nextId = 1;
  constructor(
    public uniqueKeys: string[][] = [],
    public idPrefix = "row",
  ) {}
  genId(): string {
    return `${this.idPrefix}-${this.nextId++}`;
  }
}

function matchesFilters(row: Row, filters: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key.startsWith("is_")) {
      const col = key.slice(3);
      if (value === null ? row[col] !== null : row[col] !== value) return false;
    } else if (key.startsWith("not_null_")) {
      const col = key.slice(9);
      if (row[col] === null || row[col] === undefined) return false;
    } else {
      if (row[key] !== value) return false;
    }
  }
  return true;
}

function createFakeSupabase(
  tables: Record<string, FakeTable>,
): AppSupabaseClient {
  function from(tableName: string) {
    const table = tables[tableName];
    const filters: Record<string, unknown> = {};
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | undefined;
    let orderCol: string | null = null;
    let limitN: number | null = null;

    function currentRows(): Row[] {
      let rows = (table?.rows ?? []).filter((r) => matchesFilters(r, filters));
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = String(a[orderCol as string] ?? "");
          const bv = String(b[orderCol as string] ?? "");
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    function applyWrite(): {
      data: Row | Row[] | null;
      error: { code?: string; message?: string } | null;
    } {
      if (!table) return { data: null, error: null };

      if (op === "insert") {
        const items = Array.isArray(payload) ? payload : [payload as Row];
        const created: Row[] = [];
        for (const item of items) {
          const newRow: Row = {
            id: table.genId(),
            created_at: new Date().toISOString(),
            ...item,
          };
          for (const keySet of table.uniqueKeys) {
            const dup = table.rows.some((r) =>
              keySet.every((k) => r[k] === newRow[k]),
            );
            if (dup)
              return {
                data: null,
                error: { code: "23505", message: "duplicate key" },
              };
          }
          table.rows.push(newRow);
          created.push(newRow);
        }
        return {
          data: Array.isArray(payload) ? created : (created[0] ?? null),
          error: null,
        };
      }

      if (op === "delete") {
        const matched = currentRows();
        table.rows = table.rows.filter((r) => !matched.includes(r));
        return { data: matched, error: null };
      }

      // update
      const matched = currentRows();
      for (const row of matched) Object.assign(row, payload);
      return {
        data: matched.length > 0 ? (matched[0] ?? null) : null,
        error: null,
      };
    }

    const builder = {
      select() {
        return builder;
      },
      insert(p: Row | Row[]) {
        op = "insert";
        payload = p;
        return builder;
      },
      update(p: Row) {
        op = "update";
        payload = p;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      is(column: string, value: unknown) {
        filters[`is_${column}`] = value;
        return builder;
      },
      not(column: string, _op: string, _value: unknown) {
        filters[`not_null_${column}`] = true;
        return builder;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderCol = column;
        void opts;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      async maybeSingle() {
        if (op === "select") {
          const rows = currentRows();
          return { data: rows[0] ?? null, error: null };
        }
        return applyWrite();
      },
      async single() {
        if (op === "select") {
          const rows = currentRows();
          return {
            data: rows[0] ?? null,
            error: rows[0] ? null : { message: "not found" },
          };
        }
        const result = applyWrite();
        return Array.isArray(result.data)
          ? { data: result.data[0] ?? null, error: result.error }
          : result;
      },
      then(
        onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        const result =
          op === "select" ? { data: currentRows(), error: null } : applyWrite();
        const normalized =
          op !== "select" && !Array.isArray(result.data)
            ? { data: result.data ? [result.data] : [], error: result.error }
            : result;
        return Promise.resolve(normalized).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  async function rpc(fnName: string, args?: Record<string, unknown>) {
    if (fnName === "claim_next_transcription_job") {
      const transcripts = tables.meeting_transcripts;
      if (!transcripts) return { data: null, error: null };
      const claimable = transcripts.rows.find(
        (r) =>
          r.processing_status === "pending" ||
          r.processing_status === "retryable",
      );
      if (!claimable) return { data: null, error: null };
      claimable.processing_status = "processing";
      return { data: claimable, error: null };
    }

    if (fnName === "complete_transcription_job") {
      // Mirrors complete_transcription_job (migration 060003): refuses an
      // already-completed transcript, otherwise atomically
      // replaces its segments and marks it completed — same shape as the
      // real SQL function, so this fake actually exercises the same
      // "delete then insert" idempotency semantics via a single call.
      const transcripts = tables.meeting_transcripts;
      const segments = tables.transcript_segments;
      if (!transcripts || !segments) return { data: false, error: null };
      const transcript = transcripts.rows.find(
        (r) =>
          r.id === args?.p_transcript_id &&
          r.organization_id === args?.p_organization_id,
      );
      if (!transcript || transcript.processing_status === "completed") {
        return { data: false, error: null };
      }

      segments.rows = segments.rows.filter(
        (s) => s.transcript_id !== args?.p_transcript_id,
      );
      const incoming = (args?.p_segments as Row[] | undefined) ?? [];
      for (const seg of incoming) {
        segments.rows.push({
          id: segments.genId(),
          organization_id: args?.p_organization_id,
          transcript_id: args?.p_transcript_id,
          speaker_label: "speaker_unknown",
          speaker_source: "unavailable",
          ...seg,
        });
      }

      Object.assign(transcript, {
        processing_status: "completed",
        model: args?.p_model,
        detected_language: args?.p_detected_language,
        has_canonical_english: args?.p_has_canonical_english,
        source_audio_reference: args?.p_source_audio_reference,
        provider_metadata: args?.p_provider_metadata,
        usage_seconds: args?.p_usage_seconds,
        usage_cost: args?.p_usage_cost,
        error_code: null,
        safe_error_metadata: null,
        completed_at: new Date().toISOString(),
      });
      return { data: true, error: null };
    }

    return { data: null, error: { message: `unmocked rpc: ${fnName}` } };
  }

  return { from, rpc } as unknown as AppSupabaseClient;
}

function makeTables() {
  return {
    meeting_bot_jobs: new FakeTable([], "job"),
    meeting_transcripts: new FakeTable(
      [["organization_id", "meeting_id"]],
      "transcript",
    ),
    transcript_segments: new FakeTable(
      [["transcript_id", "sequence_index"]],
      "segment",
    ),
    meeting_lifecycle_events: new FakeTable([], "event"),
  };
}

function fakeVexaFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/transcripts/")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: 1,
              status: "completed",
              media_files: [{ id: 10, type: "audio", format: "webm" }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/media/")) {
      return new Response(syntheticAudioBytes, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

function fakeEnglishProvider(): TranscriptionProvider {
  return {
    name: "fake",
    transcribe: vi.fn(async () => ({
      text: "We should shift toward Python.",
      detectedLanguage: "en",
      durationSeconds: 1,
      segments: [
        {
          index: 0,
          startMs: 0,
          endMs: 900,
          text: "We should shift toward Python.",
          confidence: 0.9,
        },
      ],
      words: null,
      model: "fake-model",
      usage: { seconds: 1, cost: 0.0001 },
      providerMetadata: {},
    })),
  };
}

function fakeTeluguProvider(): TranscriptionProvider {
  return {
    name: "fake",
    transcribe: vi.fn(async () => ({
      text: "Python side ki shift avvali.",
      detectedLanguage: "te",
      durationSeconds: 1,
      segments: [
        {
          index: 0,
          startMs: 0,
          endMs: 900,
          text: "Python side ki shift avvali.",
          confidence: 0.6,
        },
      ],
      words: null,
      model: "fake-model",
      usage: { seconds: 1, cost: 0.0001 },
      providerMetadata: {},
    })),
  };
}

function fakeNormalizationProvider(
  canonical = "Shift toward Python.",
): EnglishNormalizationProvider {
  return {
    name: "fake",
    normalize: vi.fn(async () => ({
      canonicalEnglishText: canonical,
      confidence: null,
    })),
  };
}

const baseJob = {
  organization_id: "org-1",
  meeting_id: "meeting-1",
  status: "completed",
  provider_bot_id: "teams/19%3Ameeting_abc%40thread.v2",
};

describe("enqueuePendingTranscriptions", () => {
  it("creates one pending transcript per completed bot job without an existing transcript", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const supabase = createFakeSupabase(tables);

    const result = await enqueuePendingTranscriptions(supabase, "org-1");
    expect(result.enqueued).toBe(1);
    expect(tables.meeting_transcripts.rows).toHaveLength(1);
    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe(
      "pending",
    );
  });

  it("is idempotent — a second scan does not create a duplicate transcript", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const supabase = createFakeSupabase(tables);

    await enqueuePendingTranscriptions(supabase, "org-1");
    const second = await enqueuePendingTranscriptions(supabase, "org-1");
    expect(second.enqueued).toBe(0);
    expect(tables.meeting_transcripts.rows).toHaveLength(1);
  });
});

describe("processTranscriptionJob", () => {
  it("completes the full real pipeline for a clean English segment", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 0,
    };
    tables.meeting_transcripts.rows.push(transcript);
    const supabase = createFakeSupabase(tables);

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: fakeVexaFetch(),
    });

    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe(
      "completed",
    );
    expect(tables.meeting_transcripts.rows[0]?.detected_language).toBe("en");
    expect(tables.transcript_segments.rows).toHaveLength(1);
    const seg = tables.transcript_segments.rows[0];
    expect(seg?.original_text).toBe("We should shift toward Python.");
    expect(seg?.canonical_english_text).toBe("We should shift toward Python.");
    expect(seg?.needs_review).toBe(false);
    expect(seg?.speaker_label).toBe("speaker_unknown");
    expect(seg?.speaker_source).toBe("unavailable");
  });

  it("marks non-English segments needs_review=true and calls the normalization provider, preserving original_text", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 0,
    };
    tables.meeting_transcripts.rows.push(transcript);
    const supabase = createFakeSupabase(tables);
    const normalizationProvider = fakeNormalizationProvider(
      "Shift toward Python.",
    );

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeTeluguProvider(),
      normalizationProvider,
      fetchImpl: fakeVexaFetch(),
    });

    expect(normalizationProvider.normalize).toHaveBeenCalledWith(
      "Python side ki shift avvali.",
      "te",
    );
    const seg = tables.transcript_segments.rows[0];
    expect(seg?.original_text).toBe("Python side ki shift avvali.");
    expect(seg?.canonical_english_text).toBe("Shift toward Python.");
    expect(seg?.needs_review).toBe(true);
  });

  it("keeps original_text and needs_review=true when normalization fails for a segment (graceful degradation)", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 0,
    };
    tables.meeting_transcripts.rows.push(transcript);
    const supabase = createFakeSupabase(tables);
    const failingNormalizer: EnglishNormalizationProvider = {
      name: "fake",
      normalize: vi.fn(async () => {
        throw new Error("normalization boom");
      }),
    };

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeTeluguProvider(),
      normalizationProvider: failingNormalizer,
      fetchImpl: fakeVexaFetch(),
    });

    // The transcript pipeline itself still completes — one bad
    // normalization call must not fail the whole meeting.
    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe(
      "completed",
    );
    const seg = tables.transcript_segments.rows[0];
    expect(seg?.original_text).toBe("Python side ki shift avvali.");
    expect(seg?.canonical_english_text).toBeNull();
    expect(seg?.needs_review).toBe(true);
  });

  it("marks the transcript retryable with error_code=recording_not_ready when no recording exists yet", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 0,
    };
    tables.meeting_transcripts.rows.push(transcript);
    const supabase = createFakeSupabase(tables);

    const noRecordingFetch = (async (url: string | URL) => {
      if (String(url).includes("/transcripts/")) {
        return new Response(JSON.stringify({ recordings: [] }), {
          status: 200,
        });
      }
      throw new Error("should not reach media download");
    }) as unknown as typeof fetch;

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: noRecordingFetch,
    });

    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe(
      "retryable",
    );
    expect(tables.meeting_transcripts.rows[0]?.error_code).toBe(
      "recording_not_ready",
    );
    expect(tables.meeting_transcripts.rows[0]?.retry_count).toBe(1);
    expect(tables.transcript_segments.rows).toHaveLength(0);
  });

  it("does not create duplicate segments when reprocessed after a partial prior attempt (retry idempotency)", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 1,
    };
    tables.meeting_transcripts.rows.push(transcript);
    // Simulate a segment left over from a crashed earlier attempt.
    tables.transcript_segments.rows.push({
      id: "stale-1",
      organization_id: "org-1",
      transcript_id: "t1",
      sequence_index: 0,
      original_text: "stale leftover text",
    });
    const supabase = createFakeSupabase(tables);

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: fakeVexaFetch(),
    });

    expect(tables.transcript_segments.rows).toHaveLength(1);
    expect(tables.transcript_segments.rows[0]?.original_text).toBe(
      "We should shift toward Python.",
    );
  });
});

describe("processTranscriptionQueue", () => {
  it("claims and processes pending jobs, reporting completed counts", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
    });
    const supabase = createFakeSupabase(tables);

    const result = await processTranscriptionQueue(
      supabase,
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: fakeEnglishProvider(),
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
      },
      5,
    );

    expect(result.claimed).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.failedOrRetrying).toBe(0);
  });

  it("stops when there are no more claimable jobs", async () => {
    const tables = makeTables();
    const supabase = createFakeSupabase(tables);
    const result = await processTranscriptionQueue(
      supabase,
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: fakeEnglishProvider(),
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
      },
      5,
    );
    expect(result.claimed).toBe(0);
  });
});
