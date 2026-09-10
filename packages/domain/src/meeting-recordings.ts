import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

type MeetingRecordingRow = Database["public"]["Tables"]["meeting_recordings"]["Row"];

export const MEETING_RECORDINGS_BUCKET = "meeting-recordings";

/**
 * One helper owns path construction — nothing else in this codebase
 * builds a meeting_recordings storage path. Deterministic by design
 * (spec §6): the SAME organizationId+meetingId always produces the SAME
 * path, which is what makes crash recovery (Task 5) possible without
 * needing to look anything up first.
 */
export function getMeetingRecordingStoragePath(
  organizationId: string,
  meetingId: string,
  extension: string,
): string {
  return `organizations/${organizationId}/meetings/${meetingId}/original.${extension}`;
}

/**
 * Provider-independent shape (spec §5/§10) — deliberately does not
 * include source_metadata, which stays internal to this module and is
 * only ever surfaced through the admin-only Technical Details path
 * Meeting Detail already established, never through this type.
 */
export interface OwnedRecordingRef {
  id: string;
  organizationId: string;
  meetingId: string;
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
 * UNIQUE(organization_id, meeting_id) (Task 1 migration) means at most one
 * row per meeting — .maybeSingle() is correct here, not .single() or an
 * array read.
 */
export async function getOwnedMeetingRecording(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<OwnedRecordingRef | null> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select(
      "id, organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}
