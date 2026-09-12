import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import {
  getMeetingRecordingRefs,
  type MediaKind,
} from "@applywizz/domain/meeting-recordings";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServiceRoleKey } from "@/env/server";

const SIGNED_URL_EXPIRY_SECONDS = 600;

/**
 * P3: Returns signed URLs for both audio and video recordings (when available).
 * Authorization path (spec §9, confirmed against the real
 * meeting_recordings_select_meeting_visible RLS policy from Task 1's
 * migration): the requester's OWN authenticated client (getSupabaseServerClient,
 * request-scoped and RLS-respecting) does the read that decides visibility —
 * meeting_recordings' RLS policy is a bare EXISTS against meetings, so
 * meetings' own existing org/manager-scope policies make the real decision,
 * transitively, with zero duplicated authorization logic here. Only after
 * that succeeds does a service-role client ever get constructed (same
 * createSupabaseServiceRoleClient helper Task 7 uses), and only to sign a
 * short-lived URL — never to read or return anything else. No permanent/
 * public URL is ever produced: createSignedUrl's expiry is capped at 10
 * minutes.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: meetingId } = await params;
    const supabase = await getSupabaseServerClient();

    const recordings = await getMeetingRecordingRefs(supabase, meetingId);
    if (!recordings.audio && !recordings.video) {
      return NextResponse.json(
        { error: "No recording is available for this meeting." },
        { status: 404 },
      );
    }

    const clientEnv = getClientEnv();
    const serviceRoleClient = createSupabaseServiceRoleClient(
      clientEnv.NEXT_PUBLIC_SUPABASE_URL,
      getSupabaseServiceRoleKey(),
    );

    interface SignedRecording {
      url: string;
      mediaKind: MediaKind;
      contentType: string;
      byteSize: number;
      durationSeconds: number | null;
    }

    const result: { audio?: SignedRecording; video?: SignedRecording } = {};

    if (recordings.audio) {
      const { data, error } = await serviceRoleClient.storage
        .from(recordings.audio.storageBucket)
        .createSignedUrl(recordings.audio.storagePath, SIGNED_URL_EXPIRY_SECONDS);
      if (!error && data) {
        result.audio = {
          url: data.signedUrl,
          mediaKind: "audio",
          contentType: recordings.audio.contentType,
          byteSize: recordings.audio.byteSize,
          durationSeconds: recordings.audio.durationSeconds,
        };
      }
    }

    if (recordings.video) {
      const { data, error } = await serviceRoleClient.storage
        .from(recordings.video.storageBucket)
        .createSignedUrl(recordings.video.storagePath, SIGNED_URL_EXPIRY_SECONDS);
      if (!error && data) {
        result.video = {
          url: data.signedUrl,
          mediaKind: "video",
          contentType: recordings.video.contentType,
          byteSize: recordings.video.byteSize,
          durationSeconds: recordings.video.durationSeconds,
        };
      }
    }

    if (!result.audio && !result.video) {
      return NextResponse.json(
        { error: "Could not create a playback link right now." },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ...result,
      expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS,
    });
  } catch (error) {
    // meeting_recordings has zero table-level grants for `anon` (Task 1's
    // migration: `revoke all ... from anon`), so an unauthenticated caller's
    // request-scoped client hits a genuine Postgres permission-denied error
    // (42501) inside getOwnedMeetingRecording, not an RLS-filtered empty
    // result. An authenticated caller who simply isn't authorized for this
    // meeting never reaches this catch — RLS filters their read to zero
    // rows, which getOwnedMeetingRecording already turns into the same 404
    // as "no recording yet" above, so that property is unaffected. Only the
    // genuinely-unauthenticated case is translated here, into the same 401
    // the sibling routes (meeting-policy/set, meetings/[id]/call-type) use
    // for UnauthenticatedError — it reveals nothing about this meeting,
    // only that the caller has no session at all.
    const pgError = error as { code?: string };
    if (pgError.code === "42501") {
      return NextResponse.json({ error: "No authenticated user." }, { status: 401 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "Could not create a playback link right now." },
      { status: 500 },
    );
  }
}
