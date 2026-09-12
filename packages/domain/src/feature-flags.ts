/**
 * P3: Feature flags for screen recording E2E.
 * 
 * Simple environment-variable-based feature flags. Video recording remains
 * OFF by default until owner verifies Vexa provides video artifacts
 * (see docs/product/screen-recording-spike.md for verification runbook).
 * 
 * Design: No database feature flags table — keeps E2E deployment simple.
 * Future: migrate to database-backed flags if per-org control needed.
 */

export interface FeatureFlags {
  /**
   * P3: Enable video recording ingestion and playback.
   * 
   * When FALSE (default):
   * - Video ingestion still attempts but logs "video_not_available" (expected)
   * - UI shows audio-only player
   * - Landing page copy says "Audio-only recording"
   * 
   * When TRUE:
   * - Video ingestion failures logged as "video_ingestion_failed" (investigate)
   * - UI shows video player when available, audio fallback
   * - Landing page copy mentions screen recording
   * 
   * Set via: ENABLE_VIDEO_RECORDING=true in environment
   */
  enableVideoRecording: boolean;

  /**
   * P3: Enable audio recording (always true in initial release).
   * Exists for symmetry with video flag and future policy flexibility.
   * 
   * When FALSE (hypothetical future):
   * - Audio ingestion would be skipped
   * - Transcription would fail
   * - DNR policy would block bot scheduling
   * 
   * Set via: ENABLE_AUDIO_RECORDING=false to disable (NOT RECOMMENDED)
   */
  enableAudioRecording: boolean;
}

/**
 * Reads feature flags from environment variables.
 * Called at module load time — feature flags are deployment-time config,
 * not request-time config.
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    // P3: Video recording OFF by default (owner must enable after Vexa verification)
    enableVideoRecording: process.env.ENABLE_VIDEO_RECORDING === "true",
    
    // Audio recording always ON (disabling would break transcription)
    enableAudioRecording: process.env.ENABLE_AUDIO_RECORDING !== "false",
  };
}

/**
 * Convenience: check if video recording is enabled.
 * Use this in ingest workers, UI components, and landing page.
 */
export function isVideoRecordingEnabled(): boolean {
  return getFeatureFlags().enableVideoRecording;
}

/**
 * Convenience: check if audio recording is enabled.
 * Use this in ingest workers and bot scheduling.
 */
export function isAudioRecordingEnabled(): boolean {
  return getFeatureFlags().enableAudioRecording;
}
