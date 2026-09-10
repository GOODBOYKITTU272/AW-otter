import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@applywizz/database/server";
import { getOwnedMeetingRecording } from "@applywizz/domain/meeting-recordings";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServiceRoleKey } from "@/env/server";

const SIGNED_URL_EXPIRY_SECONDS = 600;

/**
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
  const { id: meetingId } = await params;
  const supabase = await getSupabaseServerClient();

  const recording = await getOwnedMeetingRecording(supabase, meetingId);
  if (!recording) {
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
  const { data, error } = await serviceRoleClient.storage
    .from(recording.storageBucket)
    .createSignedUrl(recording.storagePath, SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data) {
    return NextResponse.json(
      { error: "Could not create a playback link right now." },
      { status: 500 },
    );
  }

  return NextResponse.json({
    url: data.signedUrl,
    expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS,
  });
}
