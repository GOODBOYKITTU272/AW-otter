import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";
import {
  downloadRecordingMedia,
  getMeetingRecordingRef,
  type VexaEnv,
} from "@applywizz/meeting-bots";
import {
  downloadGraphRecording,
  pollForCloudRecording,
  type GraphCloudRecording,
} from "@applywizz/microsoft";

export type AppSupabaseClient = SupabaseClient<Database>;

type MeetingRecordingRow = Database["public"]["Tables"]["meeting_recordings"]["Row"];

export const MEETING_RECORDINGS_BUCKET = "meeting-recordings";

export type MediaKind = "audio" | "video";

/**
 * One helper owns path construction — nothing else in this codebase
 * builds a meeting_recordings storage path. Deterministic by design
 * (P3 extension): the SAME organizationId+meetingId+mediaKind always
 * produces the SAME path, which is what makes crash recovery possible
 * without needing to look anything up first.
 *
 * P3 change: now includes media_kind in path to support both audio and
 * video artifacts for the same meeting.
 */
export function getMeetingRecordingStoragePath(
  organizationId: string,
  meetingId: string,
  mediaKind: MediaKind,
  extension: string,
): string {
  return `organizations/${organizationId}/meetings/${meetingId}/${mediaKind}.original.${extension}`;
}

/**
 * Provider-independent shape (P3 extension: now includes mediaKind) —
 * deliberately does not include source_metadata, which stays internal
 * to this module and is only ever surfaced through the admin-only
 * Technical Details path Meeting Detail already established, never
 * through this type.
 */
export interface OwnedRecordingRef {
  id: string;
  organizationId: string;
  meetingId: string;
  mediaKind: MediaKind;
  storageBucket: string;
  storagePath: string;
  contentType: string;
  byteSize: number;
  durationSeconds: number | null;
  checksumSha256: string | null;
  capturedAt: string | null;
}

/**
 * snake_case DB row -> camelCase OwnedRecordingRef. Deliberately drops
 * source_metadata/source_provider — those stay internal to this module
 * (see OwnedRecordingRef doc comment above) and must never leak out
 * through this mapping.
 */
function toOwnedRecordingRef(row: MeetingRecordingRow): OwnedRecordingRef {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    mediaKind: row.media_kind as MediaKind,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    contentType: row.content_type,
    byteSize: row.byte_size,
    durationSeconds: row.duration_seconds,
    checksumSha256: row.checksum_sha256,
    capturedAt: row.captured_at,
  };
}

/**
 * P3: UNIQUE(organization_id, meeting_id, media_kind) means at most one
 * row per meeting per kind — .maybeSingle() is correct here when fetching
 * a specific kind.
 */
export async function getOwnedMeetingRecording(
  supabase: AppSupabaseClient,
  meetingId: string,
  mediaKind: MediaKind,
): Promise<OwnedRecordingRef | null> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select(
      "id, organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .eq("meeting_id", meetingId)
    .eq("media_kind", mediaKind)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}

/**
 * P3: Fetch all recording artifacts (audio and/or video) for a meeting.
 * Returns an object with optional audio and video refs, never inventing
 * artifacts that don't exist.
 */
export async function getMeetingRecordingRefs(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<{ audio?: OwnedRecordingRef; video?: OwnedRecordingRef }> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select(
      "id, organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .eq("meeting_id", meetingId);
  if (error) throw error;
  if (!data) return {};

  const refs = data.map((row) => toOwnedRecordingRef(row as MeetingRecordingRow));
  return {
    audio: refs.find((r) => r.mediaKind === "audio"),
    video: refs.find((r) => r.mediaKind === "video"),
  };
}

/** Duck-typed subset of @supabase/storage-js's real StorageFileApi (v2.115.0, confirmed during planning) — kept minimal and independently fakeable rather than importing the full SDK type. */
export interface RecordingStorageClient {
  upload(
    path: string,
    body: ArrayBuffer,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  info(path: string): Promise<{ data: { size: number; contentType?: string } | null; error: unknown }>;
}

export class RecordingStorageMismatchError extends Error {
  constructor() {
    super(
      "An object already exists at this recording's storage path but does not match the expected recording — refusing to overwrite.",
    );
    this.name = "RecordingStorageMismatchError";
  }
}

export class RecordingAlreadyExistsError extends Error {
  constructor(message = "An owned recording already exists for this meeting and cannot be overwritten.") {
    super(message);
    this.name = "RecordingAlreadyExistsError";
  }
}

// Re-exported from transcription.ts's own definition would create a
// circular import (transcription.ts will import FROM this module in
// Task 7) — this module owns its own copy of the same error shape,
// matching it exactly so transcription.ts's existing classifyError
// continues to work unmodified.
export class RecordingNotReadyError extends Error {
  constructor() {
    super("No completed Vexa recording is available for this meeting yet.");
    this.name = "RecordingNotReadyError";
  }
}

export interface EnsureOwnedRecordingInput {
  organizationId: string;
  meetingId: string;
  mediaKind: MediaKind;
  vexaMeetingId: number;
  vexaEnv: VexaEnv;
  fetchImpl?: typeof fetch;
}

export async function ensureOwnedRecording(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: EnsureOwnedRecordingInput,
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  const existing = await getOwnedMeetingRecording(
    supabase,
    input.meetingId,
    input.mediaKind,
  );
  if (existing) {
    const { data, error } = await storage.download(existing.storagePath);
    if (error || !data) throw error ?? new Error("Owned recording download returned no data.");
    const bytes = await data.arrayBuffer();
    return { recordingRef: existing, bytes };
  }

  const vexaRecording = await getMeetingRecordingRef(
    input.vexaEnv,
    input.vexaMeetingId,
    input.mediaKind,
    input.fetchImpl,
  );
  if (!vexaRecording) throw new RecordingNotReadyError();

  const path = getMeetingRecordingStoragePath(
    input.organizationId,
    input.meetingId,
    input.mediaKind,
    vexaRecording.format,
  );
  const contentType = `${input.mediaKind}/${vexaRecording.format}`;

  const preexisting = await storage.info(path);
  if (preexisting.data) {
    // Fail closed if Vexa itself didn't report a size for this media file —
    // we have no independent evidence to validate the pre-existing Storage
    // object against, and we must never treat "no evidence" as "safe to
    // accept" (see RecordingStorageMismatchError docs above).
    if (vexaRecording.fileSizeBytes === null) {
      throw new RecordingStorageMismatchError();
    }
    return reconcilePreexistingObject(
      supabase,
      storage,
      input,
      path,
      contentType,
      vexaRecording.fileSizeBytes,
    );
  }

  const bytes = await downloadRecordingMedia(
    input.vexaEnv,
    vexaRecording.recordingId,
    vexaRecording.mediaFileId,
    input.fetchImpl,
  );
  const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

  const uploadResult = await storage.upload(path, bytes, { contentType, upsert: false });
  if (uploadResult.error) {
    // Someone else uploaded between our info() check and our upload —
    // re-run the same reconciliation path rather than trusting our own
    // in-memory bytes over whatever is actually there now.
    return reconcilePreexistingObject(supabase, storage, input, path, contentType, bytes.byteLength, { checksum, bytes });
  }

  const row = await insertRecordingRow(supabase, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    mediaKind: input.mediaKind,
    bucket: MEETING_RECORDINGS_BUCKET,
    path,
    contentType,
    byteSize: bytes.byteLength,
    checksum,
    sourceMetadata: {
      recordingId: vexaRecording.recordingId,
      mediaFileId: vexaRecording.mediaFileId,
      sourceFileSizeBytes: bytes.byteLength,
      sourceFormat: vexaRecording.format,
    },
  });

  return { recordingRef: row, bytes };
}

export interface StoreOwnedRecordingInput {
  organizationId: string;
  meetingId: string;
  mediaKind: MediaKind;
  format: string;
  bytes: ArrayBuffer;
  durationSeconds?: number | null;
  sourceProvider?: string;
  sourceMetadata?: Json;
}

/**
  * Stores an owned recording, strictly enforcing immutability:
  * 1. Rejects if a meeting_recordings row already exists for this meeting+kind.
  * 2. Rejects if a storage object already exists at the deterministic path.
  * 3. Disallows upsert: true on storage uploads.
  *
  * Once stored, original recordings cannot be overwritten or mutated.
  */
export async function storeOwnedRecording(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: StoreOwnedRecordingInput,
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  const existing = await getOwnedMeetingRecording(
    supabase,
    input.meetingId,
    input.mediaKind,
  );
  if (existing) {
    throw new RecordingAlreadyExistsError(
      `An owned ${input.mediaKind} recording already exists for meeting ${input.meetingId} — immutable recordings cannot be overwritten.`,
    );
  }

  const path = getMeetingRecordingStoragePath(
    input.organizationId,
    input.meetingId,
    input.mediaKind,
    input.format,
  );
  const contentType = `${input.mediaKind}/${input.format}`;

  const preexisting = await storage.info(path);
  if (preexisting.data) {
    throw new RecordingAlreadyExistsError(
      `A storage object already exists at ${path} — immutable recordings cannot be overwritten.`,
    );
  }

  const checksum = createHash("sha256").update(new Uint8Array(input.bytes)).digest("hex");

  const uploadResult = await storage.upload(path, input.bytes, { contentType, upsert: false });
  if (uploadResult.error) {
    throw new RecordingAlreadyExistsError(
      `Failed to store recording: ${uploadResult.error.message}`,
    );
  }

  const row = await insertRecordingRow(supabase, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    mediaKind: input.mediaKind,
    bucket: MEETING_RECORDINGS_BUCKET,
    path,
    contentType,
    byteSize: input.bytes.byteLength,
    checksum,
    sourceMetadata: input.sourceMetadata ?? {
      sourceFormat: input.format,
      sourceFileSizeBytes: input.bytes.byteLength,
    },
  });

  return { recordingRef: row, bytes: input.bytes };
}

/**
 * Graph cloud recording ingest input parameters
 */
export interface EnsureGraphCloudRecordingInput {
  organizationId: string;
  meetingId: string;
  onlineMeetingId: string;
  graphAccessToken: string;
  fetchImpl?: typeof fetch;
}

/**
 * Ensure a Graph Teams cloud recording exists in owned storage.
 * 
 * Flow:
 * 1. Check if video recording already exists (idempotency)
 * 2. Poll Graph API for recording availability (max 12 min)
 * 3. Download MP4 from signed URL
 * 4. Store in meeting_recordings with media_kind='video'
 * 
 * Behind feature flag: ENABLE_VIDEO_RECORDING
 * Requires admin consent: OnlineMeetingRecording.Read.All
 * 
 * @throws RecordingNotReadyError if no recording found after polling (not an error - manual recording may not have been started)
 * @throws RecordingAlreadyExistsError if video recording already exists (idempotency)
 * @throws Error for download failures, API errors
 */
export async function ensureGraphCloudRecording(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: EnsureGraphCloudRecordingInput,
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  // Idempotency: check if video recording already exists
  const existing = await getOwnedMeetingRecording(
    supabase,
    input.meetingId,
    "video",
  );
  if (existing) {
    const { data, error } = await storage.download(existing.storagePath);
    if (error || !data) throw error ?? new Error("Owned recording download returned no data.");
    const bytes = await data.arrayBuffer();
    return { recordingRef: existing, bytes };
  }

  // Poll for recording availability (Graph processing takes ~5-10 min after meeting ends)
  const graphRecording = await pollForCloudRecording(
    input.graphAccessToken,
    input.onlineMeetingId,
    input.fetchImpl,
  );

  if (!graphRecording) {
    // No recording found after polling - this is NOT an error
    // (organizer may not have clicked Record, or auto-record policy not enabled)
    throw new RecordingNotReadyError();
  }

  // Download MP4 from Graph signed URL
  const bytes = await downloadGraphRecording(
    graphRecording.recordingContentUrl,
    input.fetchImpl,
  );

  // Store in meeting_recordings
  const result = await storeOwnedRecording(supabase, storage, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    mediaKind: "video",
    format: "mp4",
    bytes,
    durationSeconds: null, // TODO: Extract from MP4 metadata if needed
    sourceProvider: "microsoft-graph",
    sourceMetadata: {
      graphRecordingId: graphRecording.id,
      graphOnlineMeetingId: graphRecording.meetingId,
      recordedAt: graphRecording.createdDateTime,
    },
  });

  return result;
}

async function insertRecordingRow(
  supabase: AppSupabaseClient,
  input: {
    organizationId: string;
    meetingId: string;
    mediaKind: MediaKind;
    bucket: string;
    path: string;
    contentType: string;
    byteSize: number;
    checksum: string | null;
    sourceMetadata: Json;
  },
): Promise<OwnedRecordingRef> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .insert({
      organization_id: input.organizationId,
      meeting_id: input.meetingId,
      media_kind: input.mediaKind,
      storage_bucket: input.bucket,
      storage_path: input.path,
      content_type: input.contentType,
      byte_size: input.byteSize,
      checksum_sha256: input.checksum,
      source_provider: "vexa",
      source_metadata: input.sourceMetadata,
    })
    .select(
      "id, organization_id, meeting_id, media_kind, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .single();

  if (error) {
    // Same idempotency idiom as syncMeetingBotIntent (meeting-bots.ts)
    // and enqueuePendingTranscriptions (transcription.ts): a 23505 here
    // IS the unique(organization_id, meeting_id, media_kind) constraint
    // working, not a real error — a concurrent caller already won this
    // exact insert.
    if ((error as { code?: string }).code === "23505") {
      const existing = await getOwnedMeetingRecording(
        supabase,
        input.meetingId,
        input.mediaKind,
      );
      if (existing) return existing;
    }
    throw error;
  }
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}

/**
 * Handles the case where a Storage object already exists at the
 * deterministic path but no `meeting_recordings` row owns it yet — either
 * because a previous ingestion attempt uploaded successfully and then
 * crashed before its DB write, or because our own upload() just above hit
 * an upsert:false conflict from a concurrent attempt.
 *
 * SECURITY-CRITICAL (spec's crash-recovery guardrail): we never assume an
 * existing object is correct merely because it's present at the path. We
 * independently re-verify with storage.info() and compare its real
 * reported size against `expectedSizeFromVexa` — the strongest evidence
 * available (either Vexa's own reported file_size_bytes for this
 * recording, or, when this is called after our own fresh download+upload
 * conflict, the byte length of what we actually downloaded ourselves,
 * which is stronger still). ANY mismatch, however small, fails closed:
 * throws RecordingStorageMismatchError, inserts no DB row, and never
 * touches/overwrites the Storage object.
 */
async function reconcilePreexistingObject(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: EnsureOwnedRecordingInput,
  path: string,
  contentType: string,
  expectedSizeFromVexa: number,
  freshlyDownloaded?: { checksum: string; bytes: ArrayBuffer },
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  const { data: objectInfo, error: infoError } = await storage.info(path);
  if (infoError || !objectInfo) throw infoError ?? new Error("Expected an existing object but info() found none.");

  if (objectInfo.size !== expectedSizeFromVexa) {
    throw new RecordingStorageMismatchError();
  }

  const row = await insertRecordingRow(supabase, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    mediaKind: input.mediaKind,
    bucket: MEETING_RECORDINGS_BUCKET,
    path,
    contentType,
    byteSize: objectInfo.size,
    // No freshly-downloaded bytes to hash in the pure crash-recovery case
    // (we deliberately never re-download just to compute a checksum) —
    // persist a genuine SQL NULL, not an empty-string sentinel.
    checksum: freshlyDownloaded?.checksum ?? null,
    sourceMetadata: {
      reconciled: true,
      sourceFileSizeBytes: expectedSizeFromVexa,
    },
  });

  if (freshlyDownloaded) {
    return { recordingRef: row, bytes: freshlyDownloaded.bytes };
  }
  const { data, error } = await storage.download(path);
  if (error || !data) throw error ?? new Error("Reconciled recording download returned no data.");
  return { recordingRef: row, bytes: await data.arrayBuffer() };
}
