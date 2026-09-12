import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminBackLink } from "@/components/admin/admin-back-link";
import { StatusBadge, type BadgeTone } from "@/components/admin/status-badge";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// M8 minimum verification surface (locked scope: "do not redesign the
// whole Signal product" — just enough to prove the real pipeline on a
// real completed meeting). M10 adds one small read-only section below
// (this meeting's call_records/customer_truth_facts) — the confirm/
// reject/resolve workflow itself lives on /customers/:id and /actions,
// not here.

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const TRANSCRIPT_STATUS_TONE: Record<string, BadgeTone> = {
  pending: "neutral",
  processing: "info",
  completed: "success",
  retryable: "warning",
  failed: "critical",
};

const TRANSCRIPT_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  retryable: "Retrying",
  failed: "Failed",
};

export default async function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();

  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select(
      "id, title, organizer_name, organizer_email, scheduled_start, scheduled_end, lifecycle_status",
    )
    .eq("id", id)
    .maybeSingle();
  if (meetingError) throw meetingError;
  // RLS naturally returns null for a meeting this caller can't see — a
  // plain not-found page, never a distinguishable "exists but denied".
  if (!meeting) notFound();

  const { data: transcript, error: transcriptError } = await supabase
    .from("meeting_transcripts")
    .select(
      "id, processing_status, detected_language, has_canonical_english, model, usage_seconds, usage_cost, error_code, completed_at",
    )
    .eq("meeting_id", id)
    .maybeSingle();
  if (transcriptError) throw transcriptError;

  const { data: segments, error: segmentsError } = transcript
    ? await supabase
        .from("transcript_segments")
        .select(
          "id, sequence_index, start_ms, end_ms, original_text, original_language, canonical_english_text, speaker_label, speaker_source, needs_review",
        )
        .eq("transcript_id", transcript.id)
        .order("sequence_index", { ascending: true })
    : { data: [], error: null };
  if (segmentsError) throw segmentsError;

  const { data: callRecords, error: callRecordsError } = await supabase
    .from("call_records")
    .select("id, record_type, description, status")
    .eq("meeting_id", id)
    .order("created_at", { ascending: true });
  if (callRecordsError) throw callRecordsError;

  const { data: truthProposals, error: truthProposalsError } = await supabase
    .from("customer_truth_facts")
    .select("id, field_key, value, status")
    .eq("source_meeting_id", id)
    .order("detected_at", { ascending: true });
  if (truthProposalsError) throw truthProposalsError;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <AdminBackLink href="/admin/meetings" label="All meetings" />
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-[#1E1E1E]">
          {meeting.title}
        </h1>
        <p className="text-sm text-zinc-500">
          {meeting.organizer_name ?? meeting.organizer_email ?? "—"} ·{" "}
          {formatDateTime(meeting.scheduled_start)} –{" "}
          {formatDateTime(meeting.scheduled_end)}
        </p>
      </div>

      <section className="rounded-lg border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-medium text-[#1E1E1E]">Transcript</h2>
            <p className="text-xs text-zinc-500">
              English transcription (V1). Other languages may be flagged for
              review.
            </p>
          </div>
          {transcript ? (
            <StatusBadge
              tone={
                TRANSCRIPT_STATUS_TONE[transcript.processing_status] ??
                "neutral"
              }
            >
              {TRANSCRIPT_STATUS_LABEL[transcript.processing_status] ??
                transcript.processing_status}
            </StatusBadge>
          ) : (
            <StatusBadge tone="neutral">Not started</StatusBadge>
          )}
        </div>

        {!transcript ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-500">
            No transcript for this meeting yet.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-4 border-b border-zinc-200 px-4 py-3 text-xs text-zinc-500">
              <span>
                Detected language:{" "}
                <span className="font-medium text-zinc-700">
                  {transcript.detected_language ?? "—"}
                </span>
              </span>
              <span>
                Canonical English:{" "}
                <span className="font-medium text-zinc-700">
                  {transcript.has_canonical_english
                    ? "Available"
                    : "Not available"}
                </span>
              </span>
              {transcript.model && (
                <span>
                  Model:{" "}
                  <span className="font-mono text-zinc-700">
                    {transcript.model}
                  </span>
                </span>
              )}
              {transcript.error_code && (
                <span className="text-red-600">
                  Error: {transcript.error_code}
                </span>
              )}
            </div>

            {(segments ?? []).length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-zinc-500">
                {transcript.processing_status === "completed"
                  ? "This meeting had no transcribable speech."
                  : "Segments will appear once processing completes."}
              </p>
            ) : (
              <ol className="divide-y divide-zinc-100">
                {(segments ?? []).map((segment) => (
                  <li
                    key={segment.id}
                    className="flex flex-col gap-1.5 px-4 py-3"
                  >
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      <span className="font-mono">
                        {formatTimestamp(segment.start_ms)}–
                        {formatTimestamp(segment.end_ms)}
                      </span>
                      <span>
                        {segment.speaker_label === "speaker_unknown"
                          ? "Unknown speaker"
                          : segment.speaker_label}
                      </span>
                      {segment.original_language && (
                        <StatusBadge tone="neutral">
                          {segment.original_language}
                        </StatusBadge>
                      )}
                      {segment.needs_review && (
                        <StatusBadge tone="warning">Needs review</StatusBadge>
                      )}
                    </div>
                    <p className="text-sm text-[#1E1E1E]">{segment.original_text}</p>
                    {segment.canonical_english_text &&
                      segment.canonical_english_text !==
                        segment.original_text && (
                        <p className="text-sm text-zinc-500">
                          <span className="font-medium">English:</span>{" "}
                          {segment.canonical_english_text}
                        </p>
                      )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </section>

      {((callRecords ?? []).length > 0 ||
        (truthProposals ?? []).length > 0) && (
        <section className="rounded-lg border border-zinc-200 bg-white">
          <div className="border-b border-zinc-200 px-4 py-3">
            <h2 className="text-sm font-medium text-[#1E1E1E]">
              Call records &amp; truth proposals from this meeting
            </h2>
            <p className="text-xs text-zinc-500">
              Review and confirm/reject on{" "}
              <Link href="/customers" className="text-[#2C76FF] hover:underline">
                Customers
              </Link>{" "}
              or{" "}
              <Link href="/actions" className="text-[#2C76FF] hover:underline">
                Actions
              </Link>
              .
            </p>
          </div>
          <ul className="divide-y divide-zinc-100">
            {(callRecords ?? []).map((record) => (
              <li
                key={record.id}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span>{record.description}</span>
                <StatusBadge
                  tone={record.status === "detected" ? "warning" : "success"}
                >
                  {record.status}
                </StatusBadge>
              </li>
            ))}
            {(truthProposals ?? []).map((fact) => (
              <li
                key={fact.id}
                className="flex items-center justify-between px-4 py-2 text-sm"
              >
                <span>
                  {fact.field_key.replaceAll("_", " ")}:{" "}
                  {typeof fact.value === "string"
                    ? fact.value
                    : JSON.stringify(fact.value)}
                </span>
                <StatusBadge
                  tone={fact.status === "proposed" ? "warning" : "neutral"}
                >
                  {fact.status}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
