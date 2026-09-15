"use client";

import { useRef, useState, useEffect } from "react";

interface MediaPlayerProps {
  meetingId?: string;
  recordingUrl?: string | null;
  onTimeUpdate?: (currentTimeMs: number) => void;
  externalSeekMs?: number | null;
}

interface RecordingUrls {
  audio?: { url: string; mediaKind: "audio"; contentType: string };
  video?: { url: string; mediaKind: "video"; contentType: string };
  expiresInSeconds?: number;
}

export function MediaPlayer({
  meetingId,
  recordingUrl: initialRecordingUrl,
  onTimeUpdate,
  externalSeekMs,
}: MediaPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [fetchedUrls, setFetchedUrls] = useState<RecordingUrls | null>(null);
  
  // P3: Video takes precedence over audio (composite/screen share preferred)
  const hasVideo = fetchedUrls?.video?.url;
  const hasAudio = initialRecordingUrl || fetchedUrls?.audio?.url;
  const recordingUrl = initialRecordingUrl || fetchedUrls?.video?.url || fetchedUrls?.audio?.url;
  const mediaRef = hasVideo ? videoRef : audioRef;
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    if (!initialRecordingUrl && meetingId) {
      let cancelled = false;
      fetch(`/api/meetings/${meetingId}/recording-url`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: RecordingUrls | null) => {
          if (!cancelled && data && (data.audio || data.video)) {
            setFetchedUrls(data);
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [initialRecordingUrl, meetingId]);

  useEffect(() => {
    if (externalSeekMs != null && mediaRef.current) {
      const targetSec = externalSeekMs / 1000;
      mediaRef.current.currentTime = targetSec;
      mediaRef.current.play().catch(() => {});
    }
  }, [externalSeekMs, mediaRef]);

  const togglePlay = () => {
    if (!mediaRef.current) return;
    if (isPlaying) {
      mediaRef.current.pause();
    } else {
      mediaRef.current.play().catch(() => {});
    }
  };

  const handleTimeUpdate = () => {
    if (!mediaRef.current) return;
    const curr = mediaRef.current.currentTime;
    setCurrentTime(curr);
    onTimeUpdate?.(curr * 1000);
  };

  const handleLoadedMetadata = () => {
    if (!mediaRef.current) return;
    const d = mediaRef.current.duration;
    if (d === Infinity || isNaN(d)) {
      const media = mediaRef.current;
      media.currentTime = 1e6;
      media.addEventListener(
        "seeked",
        () => {
          const realDuration =
            media.duration && media.duration !== Infinity
              ? media.duration
              : media.currentTime;
          setDuration(realDuration);
          media.currentTime = 0;
        },
        { once: true },
      );
    } else {
      setDuration(d);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    if (mediaRef.current) {
      mediaRef.current.currentTime = val;
    }
    onTimeUpdate?.(val * 1000);
  };

  const skipSeconds = (seconds: number) => {
    if (!mediaRef.current) return;
    const target = Math.max(0, Math.min(duration, mediaRef.current.currentTime + seconds));
    mediaRef.current.currentTime = target;
    setCurrentTime(target);
    onTimeUpdate?.(target * 1000);
  };

  const toggleSpeed = () => {
    const rates = [1, 1.25, 1.5, 2];
    const nextRate = rates[(rates.indexOf(playbackRate) + 1) % rates.length] ?? 1;
    setPlaybackRate(nextRate);
    if (mediaRef.current) {
      mediaRef.current.playbackRate = nextRate;
    }
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {/* P3: Video player when video available, audio-only otherwise */}
      {hasVideo && recordingUrl && (
        <video
          ref={videoRef}
          src={recordingUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          className="w-full rounded-t-lg bg-black"
          aria-label="Meeting screen recording video player"
        />
      )}
      {!hasVideo && recordingUrl && (
        <audio
          ref={audioRef}
          src={recordingUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          aria-label="Meeting audio recording player"
        />
      )}

      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!recordingUrl}
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause recording" : "Play recording"}
          >
            {isPlaying ? (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg className="h-5 w-5 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={() => skipSeconds(-5)}
            className="rounded border border-zinc-200 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 min-h-[44px]"
            disabled={!recordingUrl}
            title="Rewind 5 seconds"
            aria-label="Rewind 5 seconds"
          >
            -5s
          </button>
          <button
            type="button"
            onClick={() => skipSeconds(5)}
            className="rounded border border-zinc-200 px-3 py-2 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50 disabled:cursor-not-allowed dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900 min-h-[44px]"
            disabled={!recordingUrl}
            title="Forward 5 seconds"
            aria-label="Forward 5 seconds"
          >
            +5s
          </button>

          <div className="flex-1">
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              disabled={!recordingUrl}
              className="w-full accent-indigo-600 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Seek position in recording"
              aria-valuemin={0}
              aria-valuemax={duration || 100}
              aria-valuenow={currentTime}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
            />
          </div>

          <span className="font-mono text-xs text-zinc-500 min-w-[80px] text-right" aria-live="polite">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <button
            type="button"
            onClick={toggleSpeed}
            className="rounded bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 min-h-[44px] min-w-[48px]"
            disabled={!recordingUrl}
            title="Toggle playback speed"
            aria-label={`Playback speed: ${playbackRate}x. Click to change.`}
          >
            {playbackRate}x
          </button>
        </div>

        {!recordingUrl && (
          <p className="text-[11px] text-zinc-400 italic">
            {hasAudio
              ? "Recording is loading..."
              : "Recording will appear when available. Click any transcript timestamp to scrub."}
          </p>
        )}
        {recordingUrl && hasVideo && (
          <p className="text-[11px] text-zinc-500 italic">
            Screen recording available. Click any transcript timestamp to seek.
          </p>
        )}
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
