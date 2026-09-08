function formatTimestamp(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export interface EvidenceSegment {
  id: string;
  start_ms: number;
  end_ms: number;
  original_text: string;
  speaker_label: string;
}

// Real-data evidence drill-down — same idea as M11's fixture UI, built
// fresh against a real query result instead of a hardcoded fixture.
export function EvidenceSegments({
  segments,
}: {
  segments: EvidenceSegment[];
}) {
  if (segments.length === 0) return null;

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer text-xs text-zinc-400 group-open:hidden">
        Show evidence
      </summary>
      <span className="hidden cursor-pointer text-xs text-zinc-400 group-open:inline">
        Hide evidence
      </span>
      <div className="mt-2 flex flex-col gap-2">
        {segments.map((segment) => (
          <div
            key={segment.id}
            className="rounded-md bg-zinc-50 p-2 dark:bg-zinc-950"
          >
            <div className="flex flex-wrap gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-mono">
                {formatTimestamp(segment.start_ms)}-
                {formatTimestamp(segment.end_ms)}
              </span>
              <span>{segment.speaker_label}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
              {segment.original_text}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
