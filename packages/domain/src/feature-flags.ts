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

  /**
   * Track B′: Enable lobby bypass PATCH for Apply Wizz–organized meetings.
   * 
   * When TRUE:
   * - Before bot join, PATCH /onlineMeetings/{id} to set lobbyBypassSettings.scope="everyone"
   * - Defense-in-depth: reduces lobby wait for anonymous guest bots
   * - Requires Graph permission: OnlineMeetings.ReadWrite.All (app-only)
   * - Idempotent and best-effort: bot join proceeds even if PATCH fails
   * 
   * When FALSE (default):
   * - No lobby PATCH; bots rely on tenant policy + manual admission
   * 
   * Hypothesis: meeting-level bypass helps even when tenant Track A is applied.
   * Safe to enable after tenant admin grants OnlineMeetings.ReadWrite.All.
   * 
   * Set via: ENABLE_LOBBY_BYPASS_PATCH=true in environment
   */
  enableLobbyBypassPatch: boolean;

  /**
   * Track A: Automatically add Echo as attendee to Apply Wizz–organized Teams meetings.
   * 
   * When TRUE:
   * - Before bot join, PATCH /onlineMeetings/{id} to add Echo@Applywizz.ai to attendees list
   * - Ensures Echo is on official attendee list (may help with lobby admission for invited attendees)
   * - Requires Graph permission: OnlineMeetings.ReadWrite.All (app-only)
   * - Idempotent: Graph deduplicates attendees automatically
   * - Best-effort: bot join proceeds even if PATCH fails
   * 
   * When FALSE (default):
   * - No attendee modification; bot joins as anonymous guest
   * 
   * Benefits:
   * - Improves lobby admission when tenant policy admits "invited" attendees
   * - Creates audit trail of Echo's participation
   * - May improve meeting access permissions
   * 
   * Set via: ENABLE_ECHO_ATTENDEE_INVITE=true in environment
   * Optionally configure: ECHO_UPN (default: Echo@Applywizz.ai), ECHO_OBJECT_ID
   */
  enableEchoAttendeeInvite: boolean;
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

    // Track B′: Lobby bypass PATCH OFF by default (requires OnlineMeetings.ReadWrite.All)
    enableLobbyBypassPatch: process.env.ENABLE_LOBBY_BYPASS_PATCH === "true",

    // Track A: Echo attendee invite OFF by default (requires OnlineMeetings.ReadWrite.All)
    enableEchoAttendeeInvite: process.env.ENABLE_ECHO_ATTENDEE_INVITE === "true",
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
