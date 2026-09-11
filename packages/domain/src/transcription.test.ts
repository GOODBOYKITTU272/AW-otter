import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TranscriptionApiError,
  TranscriptionTimeoutError,
  type EnglishNormalizationProvider,
  type TranscriptionProvider,
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
  // Optional fixed-row overrides, keyed by table name — lets a test
  // pre-seed e.g. an already-owned meeting_recordings row without
  // restructuring the shared FakeTable/matchesFilters harness above.
  overrides?: Record<string, Row>,
): AppSupabaseClient {
  if (overrides) {
    for (const [tableName, row] of Object.entries(overrides)) {
      const table = tables[tableName];
      if (!table) continue;
      table.rows.push({ id: table.genId(), created_at: new Date().toISOString(), ...row });
    }
  }
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
    meeting_recordings: new FakeTable(
      [["organization_id", "meeting_id"]],
      "rec",
    ),
  };
}

function fakeStorage() {
  return {
    upload: vi.fn(async () => ({ error: null })),
    download: vi.fn(),
    info: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
  };
}

function fakeVexaFetch(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/recordings?meeting_id=")) {
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
  provider_metadata: { id: 28075 },
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
      storage: fakeStorage(),
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
      storage: fakeStorage(),
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
      storage: fakeStorage(),
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
      if (String(url).includes("/recordings?meeting_id=")) {
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
      storage: fakeStorage(),
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

  it("marks the transcript retryable with error_code=recording_not_ready when the bot job's provider_metadata has no usable numeric id", async () => {
    // M17C regression: GET /recordings only accepts Vexa's numeric
    // meeting id (from provider_metadata.id) as an honored filter — a job
    // row with no provider_metadata, or one missing/malformed `id`, has
    // nothing valid to look up and must fail closed the same way a
    // missing provider_bot_id already does, not throw an unhandled error
    // or silently pass an invalid id to the API.
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob, provider_metadata: {} });
    const transcript = {
      id: "t1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "processing",
      retry_count: 0,
    };
    tables.meeting_transcripts.rows.push(transcript);
    const supabase = createFakeSupabase(tables);

    const shouldNotBeCalledFetch = (async (url: string | URL) => {
      throw new Error(`should not reach Vexa at all: ${String(url)}`);
    }) as unknown as typeof fetch;

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: shouldNotBeCalledFetch,
      storage: fakeStorage(),
    });

    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe(
      "retryable",
    );
    expect(tables.meeting_transcripts.rows[0]?.error_code).toBe(
      "recording_not_ready",
    );
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
      storage: fakeStorage(),
    });

    expect(tables.transcript_segments.rows).toHaveLength(1);
    expect(tables.transcript_segments.rows[0]?.original_text).toBe(
      "We should shift toward Python.",
    );
  });

  it("does not call any Vexa endpoint when the recording is already owned — proves Vexa independence after ingestion", async () => {
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

    // meeting_recordings already has a row — owned, per Task 6's shape.
    const ownedRow = {
      id: "rec-1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      storage_bucket: "meeting-recordings",
      storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
      content_type: "audio/webm",
      byte_size: syntheticAudioBytes.byteLength,
      duration_seconds: null,
      checksum_sha256: "abc123",
      captured_at: null,
    };

    const supabase = createFakeSupabase(tables, { meeting_recordings: ownedRow });

    let vexaEndpointCalled = false;
    const vexaCallDetectingFetch = (async (url: string | URL) => {
      vexaEndpointCalled = true;
      throw new Error(`Vexa was contacted but should not have been: ${String(url)}`);
    }) as unknown as typeof fetch;

    const storageDownloadSpy = vi.fn(async () => ({ data: new Blob([syntheticAudioBytes]), error: null }));

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: vexaCallDetectingFetch,
      storage: { upload: vi.fn(), download: storageDownloadSpy, info: vi.fn() },
    });

    expect(vexaEndpointCalled).toBe(false);
    expect(storageDownloadSpy).toHaveBeenCalledWith("organizations/org-1/meetings/meeting-1/original.webm");
    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe("completed");
  });

  it("never deletes the owned Storage object — only the local temp work directory", async () => {
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

    // RecordingStorageClient has no `remove` method — this spy is attached
    // purely to prove nothing calls it, not because the real interface exposes it.
    const removeSpy = vi.fn(async () => ({ error: null }));

    await processTranscriptionJob(supabase, transcript as never, {
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
      transcriptionProvider: fakeEnglishProvider(),
      normalizationProvider: fakeNormalizationProvider(),
      fetchImpl: fakeVexaFetch(),
      storage: { ...fakeStorage(), remove: removeSpy } as never,
    });

    expect(removeSpy).not.toHaveBeenCalled();
    expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe("completed");
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
        storage: fakeStorage(),
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
        storage: fakeStorage(),
      },
      5,
    );
    expect(result.claimed).toBe(0);
  });
});

describe("processTranscriptionJob with AzureMai provider", () => {
  function fakeAzureMaiProvider(): TranscriptionProvider {
    return {
      name: "azure-mai",
      transcribe: vi.fn(async () => ({
        text: "Speaker zero speaks. Speaker one replies.",
        detectedLanguage: "en",
        durationSeconds: 2,
        segments: [
          {
            index: 0,
            startMs: 0,
            endMs: 900,
            text: "Speaker zero speaks.",
            confidence: 0.95,
            speakerTag: "Speaker 0",
            speakerNumericId: 0,
            words: [{ word: "Speaker", startMs: 0, endMs: 400 }],
          },
          {
            index: 1,
            startMs: 1000,
            endMs: 1900,
            text: "Speaker one replies.",
            confidence: 0.92,
            speakerTag: "Speaker 1",
            speakerNumericId: 1,
            words: [{ word: "Speaker", startMs: 1000, endMs: 1400 }],
          },
        ],
        words: [
          { word: "Speaker", startMs: 0, endMs: 400 },
          { word: "Speaker", startMs: 1000, endMs: 1400 },
        ],
        model: "MAI-Transcribe-2",
        usage: { seconds: 2, cost: null },
        providerMetadata: {
          task: "transcribe",
          model: "MAI-Transcribe-2",
          speakerCount: 2,
          speakers: [0, 1],
        },
      })),
    };
  }

  it("preserves Speaker 0 and Speaker 1 labels and records PCM WAV preprocessing provenance", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-azure",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
      provider: "openrouter",
    });
    const supabase = createFakeSupabase(tables);

    const azureProvider = fakeAzureMaiProvider();
    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: azureProvider,
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    const transcript = tables.meeting_transcripts.rows[0];
    expect(transcript?.processing_status).toBe("completed");
    expect(transcript?.provider).toBe("azure-mai");
    expect(transcript?.model).toBe("MAI-Transcribe-2");

    expect(tables.transcript_segments.rows).toHaveLength(2);
    expect(tables.transcript_segments.rows[0]?.speaker_label).toBe("Speaker 0");
    expect(tables.transcript_segments.rows[1]?.speaker_label).toBe("Speaker 1");

    const meta = transcript?.provider_metadata as Record<string, unknown>;
    expect(meta.provider).toBe("azure-mai");
    expect(meta.preprocessingVersion).toBe("v1-pcm16k-wav");
    expect(typeof meta.originalSha256).toBe("string");
    expect(typeof meta.derivedSha256).toBe("string");
  });

  it("persists code-switched segment languages, preserves speakerNumericId 0 and 1, and saves word timestamps", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-azure-codeswitch",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
      provider: "openrouter",
    });
    const supabase = createFakeSupabase(tables);

    const mockProvider: TranscriptionProvider = {
      name: "azure-mai",
      transcribe: vi.fn(async () => ({
        text: "How was your interview? నేను బాగా చేశాను.",
        detectedLanguage: "en", // Whole-meeting primary detection is English
        durationSeconds: 5,
        segments: [
          {
            index: 0,
            startMs: 40,
            endMs: 2000,
            text: "How was your interview?",
            confidence: 0.98,
            speakerTag: "Speaker 0",
            speakerNumericId: 0,
            language: "en",
            words: [
              { word: "How", startMs: 40, endMs: 200 },
              { word: "was", startMs: 220, endMs: 400 },
              { word: "your", startMs: 420, endMs: 600 },
              { word: "interview?", startMs: 620, endMs: 1900 },
            ],
          },
          {
            index: 1,
            startMs: 2200,
            endMs: 4800,
            text: "నేను బాగా చేశాను.",
            confidence: 0.91,
            speakerTag: "Speaker 1",
            speakerNumericId: 1,
            language: "te",
            words: [
              { word: "నేను", startMs: 2200, endMs: 2800 },
              { word: "బాగా", startMs: 2900, endMs: 3600 },
              { word: "చేశాను.", startMs: 3700, endMs: 4700 },
            ],
          },
        ],
        words: null,
        model: "MAI-Transcribe-2",
        usage: { seconds: 5, cost: null },
        providerMetadata: { model: "MAI-Transcribe-2" },
      })),
    };

    const mockNorm: EnglishNormalizationProvider = {
      name: "test-norm",
      normalize: vi.fn(async (text: string, lang: string | null) => {
        expect(lang).toBe("te"); // Verifies Telugu segment passes 'te', not meeting 'en'!
        return {
          canonicalEnglishText: "I did well.",
          confidence: 0.94,
        };
      }),
    };

    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: mockProvider,
        normalizationProvider: mockNorm,
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    expect(tables.transcript_segments.rows).toHaveLength(2);
    const seg0 = tables.transcript_segments.rows[0]!;
    const seg1 = tables.transcript_segments.rows[1]!;

    // Segment 0: English, Speaker 0
    expect(seg0.speaker_label).toBe("Speaker 0");
    expect(seg0.original_language).toBe("en");
    expect(seg0.original_text).toBe("How was your interview?");
    expect(seg0.canonical_english_text).toBe("How was your interview?");
    expect(seg0.needs_review).toBe(false);

    const seg0Meta = seg0.provider_segment_metadata as Record<string, unknown>;
    expect(seg0Meta.speakerTag).toBe("Speaker 0");
    expect(seg0Meta.speakerNumericId).toBe(0); // 0 preserved, not falsy null!
    expect(seg0Meta.speakerSource).toBe("azure-diarization");
    expect(seg0Meta.language).toBe("en");
    expect(seg0Meta.words).toEqual([
      { word: "How", startMs: 40, endMs: 200 },
      { word: "was", startMs: 220, endMs: 400 },
      { word: "your", startMs: 420, endMs: 600 },
      { word: "interview?", startMs: 620, endMs: 1900 },
    ]);

    // Segment 1: Telugu, Speaker 1
    expect(seg1.speaker_label).toBe("Speaker 1");
    expect(seg1.original_language).toBe("te");
    expect(seg1.original_text).toBe("నేను బాగా చేశాను.");
    expect(seg1.canonical_english_text).toBe("I did well.");
    expect(seg1.needs_review).toBe(true);

    const seg1Meta = seg1.provider_segment_metadata as Record<string, unknown>;
    expect(seg1Meta.speakerTag).toBe("Speaker 1");
    expect(seg1Meta.speakerNumericId).toBe(1);
    expect(seg1Meta.speakerSource).toBe("azure-diarization");
    expect(seg1Meta.language).toBe("te");
    expect(seg1Meta.words).toEqual([
      { word: "నేను", startMs: 2200, endMs: 2800 },
      { word: "బాగా", startMs: 2900, endMs: 3600 },
      { word: "చేశాను.", startMs: 3700, endMs: 4700 },
    ]);
  });

  it("safely falls back to detectedLanguage when segment language is null/unavailable", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-fallback-lang",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
    });
    const supabase = createFakeSupabase(tables);

    const mockProvider: TranscriptionProvider = {
      name: "openrouter",
      transcribe: vi.fn(async () => ({
        text: "Hello from fallback provider.",
        detectedLanguage: "en",
        durationSeconds: 2,
        segments: [
          {
            index: 0,
            startMs: 0,
            endMs: 1500,
            text: "Hello from fallback provider.",
            confidence: 0.99,
            // language omitted/null
          },
        ],
        words: null,
        model: "whisper-large-v3-turbo",
        usage: { seconds: 2, cost: null },
        providerMetadata: {},
      })),
    };

    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: mockProvider,
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    const seg = tables.transcript_segments.rows[0]!;
    expect(seg.original_language).toBe("en");
    expect(seg.needs_review).toBe(false);

    const meta = seg.provider_segment_metadata as Record<string, unknown>;
    expect(meta.language).toBe("en");
    expect(meta.speakerTag).toBe("speaker_unknown");
    expect(meta.speakerNumericId).toBeNull();
    expect(meta.speakerSource).toBe("unavailable");
  });

  it("falls back to OpenRouter when primary Azure provider fails with timeout twice", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-fallback-timeout",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
    });
    const supabase = createFakeSupabase(tables);

    const mockAzureProvider: TranscriptionProvider = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionTimeoutError())
        .mockRejectedValueOnce(new TranscriptionTimeoutError()),
    };

    const mockOpenRouterProvider: TranscriptionProvider = {
      name: "openrouter",
      transcribe: vi.fn(async () => ({
        text: "Safety fallback transcript.",
        detectedLanguage: "en",
        durationSeconds: 2,
        segments: [
          {
            index: 0,
            startMs: 0,
            endMs: 2000,
            text: "Safety fallback transcript.",
            confidence: 0.98,
            language: "en",
          },
        ],
        words: null,
        model: "whisper-large-v3-turbo",
        usage: { seconds: 2, cost: 0.001 },
        providerMetadata: { fallbackInfo: "ok" },
      })),
    };

    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: mockAzureProvider,
        fallbackProvider: mockOpenRouterProvider,
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    const transcript = tables.meeting_transcripts.rows[0]!;
    expect(transcript.processing_status).toBe("completed");
    expect(transcript.provider).toBe("openrouter");

    const meta = transcript.provider_metadata as Record<string, unknown>;
    expect(meta.provider).toBe("openrouter");
    expect(meta.fallbackReason).toContain("Primary provider azure-mai failed after 2 attempts. Final error: TIMEOUT");
    const attempts = meta.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({ sequence: 1, provider: "azure-mai", outcome: "failed", failureCode: "TIMEOUT" });
    expect(attempts[1]).toMatchObject({ sequence: 2, provider: "azure-mai", outcome: "failed", failureCode: "TIMEOUT" });
    expect(attempts[2]).toMatchObject({ sequence: 3, provider: "openrouter", outcome: "accepted" });

    expect(mockAzureProvider.transcribe).toHaveBeenCalledTimes(2);
    expect(mockOpenRouterProvider.transcribe).toHaveBeenCalledTimes(1);
  });

  it("falls back immediately to OpenRouter when primary Azure provider fails with AUTH_FAILURE (401)", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-fallback-auth",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
    });
    const supabase = createFakeSupabase(tables);

    const mockAzureProvider: TranscriptionProvider = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValueOnce(new TranscriptionApiError(401, "Invalid Azure API key")),
    };

    const mockOpenRouterProvider: TranscriptionProvider = {
      name: "openrouter",
      transcribe: vi.fn(async () => ({
        text: "Recovered via OpenRouter.",
        detectedLanguage: "en",
        durationSeconds: 2,
        segments: [
          {
            index: 0,
            startMs: 0,
            endMs: 2000,
            text: "Recovered via OpenRouter.",
            confidence: 0.95,
            language: "en",
          },
        ],
        words: null,
        model: "whisper-large-v3-turbo",
        usage: { seconds: 2, cost: 0.001 },
        providerMetadata: {},
      })),
    };

    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: mockAzureProvider,
        fallbackProvider: mockOpenRouterProvider,
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    const transcript = tables.meeting_transcripts.rows[0]!;
    expect(transcript.processing_status).toBe("completed");
    expect(transcript.provider).toBe("openrouter");

    const meta = transcript.provider_metadata as Record<string, unknown>;
    expect(meta.fallbackReason).toContain("Primary provider azure-mai encountered non-retryable error: AUTH_FAILURE");
    const attempts = meta.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ sequence: 1, provider: "azure-mai", outcome: "failed", failureCode: "AUTH_FAILURE" });
    expect(attempts[1]).toMatchObject({ sequence: 2, provider: "openrouter", outcome: "accepted" });

    // Ensure Azure was NOT retried on auth failure
    expect(mockAzureProvider.transcribe).toHaveBeenCalledTimes(1);
    expect(mockOpenRouterProvider.transcribe).toHaveBeenCalledTimes(1);
  });

  it("marks transcript retryable and records attempts in safe_error_metadata when both providers fail", async () => {
    const tables = makeTables();
    tables.meeting_bot_jobs.rows.push({ ...baseJob });
    tables.meeting_transcripts.rows.push({
      id: "t-both-failed",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      processing_status: "pending",
      retry_count: 0,
    });
    const supabase = createFakeSupabase(tables);

    const mockAzureProvider: TranscriptionProvider = {
      name: "azure-mai",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionTimeoutError()),
    };

    const mockOpenRouterProvider: TranscriptionProvider = {
      name: "openrouter",
      transcribe: vi
        .fn()
        .mockRejectedValue(new TranscriptionApiError(500, "Service unavailable")),
    };

    await processTranscriptionJob(
      supabase,
      tables.meeting_transcripts.rows[0] as Parameters<
        typeof processTranscriptionJob
      >[1],
      {
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
        transcriptionProvider: mockAzureProvider,
        fallbackProvider: mockOpenRouterProvider,
        normalizationProvider: fakeNormalizationProvider(),
        fetchImpl: fakeVexaFetch(),
        storage: fakeStorage(),
      },
    );

    const transcript = tables.meeting_transcripts.rows[0]!;
    expect(transcript.processing_status).toBe("retryable");
    expect(transcript.retry_count).toBe(1);

    const safeMeta = transcript.safe_error_metadata as Record<string, unknown>;
    expect(safeMeta.message).toBe("All transcription providers failed.");
    expect(safeMeta.fallbackReason).toContain("Primary provider azure-mai failed after 2 attempts.");
    const attempts = safeMeta.attempts as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(3);
    expect(attempts[0]).toMatchObject({ sequence: 1, provider: "azure-mai", failureCode: "TIMEOUT" });
    expect(attempts[1]).toMatchObject({ sequence: 2, provider: "azure-mai", failureCode: "TIMEOUT" });
    expect(attempts[2]).toMatchObject({ sequence: 3, provider: "openrouter", failureCode: "PROVIDER_5XX" });
  });
});
