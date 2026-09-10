import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

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
