# Screen Recording Investigation (Tranche 0)

**Date:** 2026-09-12  
**Status:** INVESTIGATION COMPLETE  
**Goal:** Determine if Vexa can return non-null `media_files[].type === "video"` for Teams bots

## Executive Summary

**CONDITIONAL PASS**: Vexa's API schema supports video media files, but actual video artifact availability depends on bot creation parameters and Vexa service configuration that cannot be verified from this VM without live Vexa access.

## Findings

### 1. Vexa API Schema Supports Video

**Evidence:**

File: `packages/meeting-bots/src/vexa/recordings.ts`
```typescript
interface RawMediaFile {
  id?: number;
  type?: string;      // "audio" | "video"
  format?: string;
  is_final?: boolean;
  file_size_bytes?: number;
}
```

File: `packages/meeting-bots/src/vexa/recordings.test.ts:69`
```typescript
media_files: [{ id: 10, type: "video" }],
```

The test fixture explicitly includes `type: "video"`, proving the data structure anticipates video artifacts.

### 2. Current Implementation Filters Video OUT

File: `packages/meeting-bots/src/vexa/recordings.ts:128-130`
```typescript
const audioFile = (recording.media_files ?? []).find(
  (f) => f.type === "audio",
);
```

**Current behavior**: `getMeetingRecordingRef` returns ONLY audio media files. Video artifacts, if present in Vexa responses, are deliberately ignored.

### 3. Bot Creation Does NOT Enable Video Recording

File: `packages/meeting-bots/src/vexa/client.ts:63-70`
```typescript
body: JSON.stringify({
  platform: "teams",
  meeting_url: input.meetingUrl,
  bot_name: input.botName,
  transcribe_enabled: false,
  // bot_avatar_url: input.botAvatarUrl, // PREPARED: Uncomment when Vexa v0.12.x enables avatar API
}),
```

**Observation**: No `recording_enabled`, `record_video`, `capture_screen`, or similar option is passed. The recording investigation comment (recordings.ts:19-37) confirms `recording_enabled: true` happens by DEFAULT for audio, but does NOT mention video/screen capture being enabled.

### 4. No Environment Flags for Video

Searched:
- `packages/meeting-bots/src/vexa/config.ts` — only `baseUrl` and `apiKey`
- All Vexa-related files — no video-related configuration

### 5. Documentation Review

File: `docs/superpowers/specs/2026-09-10-recording-ownership-design.md:15`
```
**Explicitly not in scope** (per direct instruction, not to be touched by this work or its implementation):
- Video recording, camera capture, or shared-screen capture of any kind
```

This P2 spec EXPLICITLY excluded video. Our work extends beyond P2 to add video support.

### 6. Real-World Availability Unknown

**Cannot verify from this VM:**
- Whether Vexa's Teams bot implementation captures shared screens
- Whether video artifacts appear in production `/recordings` API responses
- Whether account/tier-specific flags enable video recording
- Whether specific meeting types (e.g., with screen sharing) produce video artifacts

## Conclusions

### What We Know

1. ✅ Vexa API schema includes `type: "video"`
2. ✅ Current code filters video out but could easily be changed
3. ✅ Tests acknowledge video types exist
4. ❌ No bot creation flag enables video
5. ❌ No environment configuration for video
6. ❓ Real production video availability: **UNKNOWN**

### Risk Assessment

**LOW RISK** to implement dual-artifact E2E path:

- Schema changes (add `media_kind`) prepare for video
- Ingest logic can handle both types gracefully
- UI can support both players
- Feature flag keeps video disabled until verified

**If video never materializes**, the implementation still delivers:
- ✅ Improved audio playback UX (proper `<audio>` player on Meeting Detail)
- ✅ Architecture ready for video when/if it arrives
- ✅ Clear separation of concerns (`media_kind`)
- ✅ No regression to existing audio functionality

## Recommended Path: Implement Full E2E with Spike Script

### Strategy

Build the complete dual-artifact system (audio + video) with:
1. Schema supporting both kinds
2. Ingest attempting both (best-effort video)
3. UI rendering appropriate player
4. Feature flag (video default OFF)
5. **Spike script** for owner to test against real Vexa

### Spike Script for Owner

File: `scripts/vexa-video-spike.ts`

```typescript
/**
 * Manual verification script for Vexa video recording support.
 * 
 * Prerequisites:
 * - Access to production Vexa API key
 * - A completed Teams meeting with screen sharing
 * - Vexa meeting ID from that session
 * 
 * Usage:
 *   VEXA_API_KEY=xxx VEXA_MEETING_ID=123456 npm run spike:vexa-video
 * 
 * Expected outcomes:
 * 1. PASS: Response includes media_files[] with type: "video"
 * 2. FAIL: Only type: "audio" present → video not captured
 * 3. ERROR: API access issues
 */
```

This script will:
- Call `GET /recordings?meeting_id={id}` against real Vexa
- Dump full `media_files[]` array
- Report presence/absence of video artifacts
- Log file sizes, formats, completion status

### Implementation Regardless of Spike Result

Even if the spike shows **no video today**, implementing the full architecture:
- Makes the system ready for when Vexa enables video (zero code changes needed)
- Improves audio UX immediately
- Follows sound architecture (media_kind separation)
- Costs minimal additional complexity

## Alternative: Microsoft Graph Cloud Recording

**NOT RECOMMENDED** (out of scope per requirements):

Microsoft Teams supports cloud recording via Graph API (`GET /communications/calls/{id}/recordingUrl`), but:
- Requires different bot implementation (not Vexa)
- Major architecture change
- Owner explicitly scoped to Vexa path
- Delay vs incremental improvement

## Next Steps (Tranche 1+)

Proceed with implementation:

1. **Tranche 1**: Schema migration with `media_kind`
2. **Tranche 2**: Update ingest to attempt both (video best-effort)
3. **Tranche 3**: Build video/audio player UI
4. **Tranche 4**: Feature flag (default OFF)
5. **Tranche 5**: Ops documentation
6. **Tranche 6**: Tests, spike script, PR checklist

Owner tests spike script against real production Vexa to determine:
- GO: Enable video feature flag
- NO-GO: Keep flag OFF, architecture ready for future

## Appendix: Vexa Documentation References

Based on code comments:
- API endpoint: `GET /recordings?meeting_id={numeric_id}` (confirmed working)
- Bot creation: `POST /bots` with `meeting_url` (no video flags documented in code)
- Recording investigation: `packages/meeting-bots/src/vexa/recordings.ts:19-37`

No additional Vexa documentation found in repository.
