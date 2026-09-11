"use client";

import { useRef, useState, useEffect } from "react";

interface MediaPlayerProps {
  meetingId?: string;
  recordingUrl?: string | null;
  onTimeUpdate?: (currentTimeMs: number) => void;
  externalSeekMs?: number | null;
}

export function MediaPlayer({
  meetingId,
  recordingUrl: initialRecordingUrl,
  onTimeUpdate,
  externalSeekMs,
}: MediaPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const recordingUrl = initialRecordingUrl || fetchedUrl;
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    if (!initialRecordingUrl && meetingId) {
      let cancelled = false;
      fetch(`/api/meetings/${meetingId}/recording-url`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data?.url) {
            setFetchedUrl(data.url);
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }
  }, [initialRecordingUrl, meetingId]);

  useEffect(() => {
    if (externalSeekMs != null && audioRef.current) {
      const targetSec = externalSeekMs / 1000;
      audioRef.current.currentTime = targetSec;
      audioRef.current.play().catch(() => {});
    }
  }, [externalSeekMs]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {});
    }
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    const curr = audioRef.current.currentTime;
    setCurrentTime(curr);
    onTimeUpdate?.(curr * 1000);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    const d = audioRef.current.duration;
    if (d === Infinity || isNaN(d)) {
      const audio = audioRef.current;
      audio.currentTime = 1e6;
      audio.addEventListener(
        "seeked",
        () => {
          const realDuration =
            audio.duration && audio.duration !== Infinity
              ? audio.duration
              : audio.currentTime;
          setDuration(realDuration);
          audio.currentTime = 0;
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
    if (audioRef.current) {
      audioRef.current.currentTime = val;
    }
    onTimeUpdate?.(val * 1000);
  };

  const skipSeconds = (seconds: number) => {
    if (!audioRef.current) return;
    const target = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
    audioRef.current.currentTime = target;
    setCurrentTime(target);
    onTimeUpdate?.(target * 1000);
  };

  const toggleSpeed = () => {
    const rates = [1, 1.25, 1.5, 2];
    const nextRate = rates[(rates.indexOf(playbackRate) + 1) % rates.length] ?? 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      {recordingUrl && (
        <audio
          ref={audioRef}
          src={recordingUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={togglePlay}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-600 text-white hover:bg-indigo-700 transition"
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg className="h-4 w-4 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24">
                <polygon points="5,3 19,12 5,21" />
              </svg>
            )}
          </button>

          <button
            type="button"
            onClick={() => skipSeconds(-5)}
            className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
            title="Rewind 5 seconds"
          >
            -5s
          </button>
          <button
            type="button"
            onClick={() => skipSeconds(5)}
            className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
            title="Forward 5 seconds"
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
              className="w-full accent-indigo-600 cursor-pointer"
            />
          </div>

          <span className="font-mono text-xs text-zinc-500 min-w-[75px] text-right">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <button
            type="button"
            onClick={toggleSpeed}
            className="rounded bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
            title="Toggle playback speed"
          >
            {playbackRate}x
          </button>
        </div>

        {!recordingUrl && (
          <p className="text-[11px] text-zinc-400 italic">
            Audio recording available in storage. Click any transcript timestamp below to scrub.
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
