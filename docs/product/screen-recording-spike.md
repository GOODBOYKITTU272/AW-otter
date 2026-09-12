# Screen Recording Investigation (Tranche 0)

**Date:** 2026-09-12  
**Status:** INVESTIGATION COMPLETE  
**Goal:** Determine if Vexa can return non-null `media_files[].type === "video"` for Teams bots

## Executive Summary

**FAIL (Audio PASS)**: Live spike against production Vexa confirmed audio-only recordings. Vexa API schema supports video media files, but current bot configuration does NOT produce video artifacts.

**Live Spike Result (2026-09-12):**
- Tested against production Vexa API with real credentials
- 3 completed recordings examined
- ALL returned `type: "audio"` only (webm format)
- ZERO `type: "video"` media files present
- Audio recording: ✅ WORKING (2-3 MB files)
- Video recording: ❌ NOT AVAILABLE

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

### What We Know (VERIFIED)

1. ✅ Vexa API schema includes `type: "video"`
2. ✅ Current code supports video ingestion (dual-artifact model implemented)
3. ✅ Tests cover video scenarios
4. ❌ No bot creation flag enables video (see investigation below)
5. ❌ No environment configuration for video
6. ✅ **Real production video availability: CONFIRMED UNAVAILABLE** (spike 2026-09-12)

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

## Live Spike Results (2026-09-12)

### Actual Production Output

```bash
$ VEXA_API_KEY=xxx VEXA_MEETING_ID=xxx tsx scripts/vexa-video-spike.ts

Recording #1:
  ID: 981175381669
  Status: completed
  Media files: 1

  Media File:
    ID: 903850064950
    Type: audio
    Format: webm
    Size: 0.24 MB
    Duration: 19s

Recording #2:
  ID: 922670406417
  Status: completed
  Media files: 1

  Media File:
    ID: 794536767523
    Type: audio
    Format: webm
    Size: 1.99 MB
    Duration: 157s

Recording #3:
  ID: 677977333783
  Status: completed
  Media files: 1

  Media File:
    ID: 585089337407
    Type: audio
    Format: webm
    Size: 3.24 MB
    Duration: 257s

⚠️  RESULT: Vexa provides audio ONLY (no video)
```

### Interpretation

- **Audio recording:** ✅ Working as designed
- **Video recording:** ❌ Not captured by current Vexa bot configuration
- **File sizes:** Typical for audio-only (2-10 MB per meeting)
- **Format:** WebM audio (requires transcode for STT, already implemented)

### Root Cause Investigation

Checked `packages/meeting-bots/src/vexa/client.ts` POST /bots payload:

```typescript
body: JSON.stringify({
  platform: "teams",
  meeting_url: input.meetingUrl,
  bot_name: input.botName,
  transcribe_enabled: false,
  // NO VIDEO FLAGS PRESENT
}),
```

**Missing flags (hypothetical, not documented by Vexa):**
- `recording_enabled: true` — assumed default per M8 investigation
- `record_audio: true` — assumed default
- `record_video: true` — **NOT SET** (likely needed for video)
- `record_screen: true` — **NOT SET** (alternative name?)
- `capture_mode: "composite"` — **NOT SET** (gallery + screen share?)

**Vexa API documentation gaps:**
- No public docs for video recording flags
- M8/M17C investigations only confirmed audio recording works
- Bot creation response does NOT echo recording settings

## Alternative: Microsoft Graph Cloud Recording

**FALLBACK OPTION** if Vexa video cannot be enabled:

Microsoft Teams native cloud recording via Graph API provides composite video (gallery + screen share + audio).

### Prerequisites

1. **Microsoft Graph API permissions:**
   - `OnlineMeetings.Read.All` — read meeting metadata
   - `OnlineMeetingRecording.Read.All` — download recordings
   - Application-level permissions (not delegated)

2. **Teams meeting configuration:**
   - Cloud recording must be enabled in Teams admin center
   - Organizer must start recording during meeting (manual action)
   - OR: Meeting policy auto-starts recording

3. **Existing infrastructure:**
   - `packages/microsoft/src/graph-client.ts` — Graph client already exists
   - Auth token refresh already implemented
   - Webhook handling for meeting events present

### Implementation Sketch

```typescript
// packages/microsoft/src/graph-recording.ts

interface CloudRecording {
  id: string;
  meetingId: string;
  recordingContentUrl: string; // download URL
  createdDateTime: string;
}

export async function getCloudRecordings(
  graphClient: GraphClient,
  meetingId: string,
): Promise<CloudRecording[]> {
  // GET /communications/onlineMeetings/{meetingId}/recordings
  const response = await graphClient.get(
    `/communications/onlineMeetings/${meetingId}/recordings`
  );
  return response.value;
}

export async function downloadCloudRecording(
  graphClient: GraphClient,
  recordingContentUrl: string,
): Promise<ArrayBuffer> {
  // recordingContentUrl is a signed URL, expires after ~1 hour
  const response = await fetch(recordingContentUrl);
  return response.arrayBuffer();
}
```

### Integration Points

1. **Detection:** Check if native cloud recording exists before/after Vexa bot
2. **Ingestion:** Download from Graph API instead of Vexa
3. **Storage:** Use same `meeting_recordings` table, `source_provider: 'microsoft-graph'`
4. **Lifecycle:** Graph recordings available ~5-10 minutes after meeting ends

### Limitations

1. **Manual recording start:** Organizer must click "Record" (unless policy auto-starts)
2. **Permissions:** Requires tenant admin to grant recording permissions
3. **Availability delay:** Graph recordings not instant (5-10 min post-meeting)
4. **Format:** MP4 video (larger than Vexa audio, ~200-500 MB per hour)

### Recommendation

**DO NOT IMPLEMENT** in this PR:
- Requires Graph API permission changes (tenant admin action)
- Manual recording dependency (organizer must remember to record)
- Increases complexity without guaranteed Vexa path fix
- Better as separate feature flag: `ENABLE_GRAPH_CLOUD_RECORDING`

**DEFER** to next PR if:
1. Vexa confirms video is impossible with current API
2. Customer demand for screen recordings is high
3. Tenant admin approves Graph recording permissions

**Document** as known alternative for product roadmap.

## Next Steps

### Immediate Actions (COMPLETED ✅)

All tranches implemented with video support ready:

1. ✅ **Tranche 1**: Schema migration with `media_kind` — DONE
2. ✅ **Tranche 2**: Dual-artifact ingest (audio + video best-effort) — DONE
3. ✅ **Tranche 3**: Video/audio player UI on Meeting Detail — DONE
4. ✅ **Tranche 4**: Feature flag `ENABLE_VIDEO_RECORDING=false` — DONE
5. ✅ **Tranche 5**: Ops documentation — DONE
6. ✅ **Tranche 6**: Tests passing, PR open — DONE

**Deliverable:** Meeting Detail playable **audio** player NOW + architecture ready for video

### Investigation Actions (TODO)

1. **Contact Vexa support:**
   - Ask if video recording is available on current plan/tier
   - Request documentation for video recording flags
   - Hypothetical flags: `record_video`, `record_screen`, `capture_mode`

2. **Test undocumented flags (IF support confirms):**
   ```typescript
   // packages/meeting-bots/src/vexa/client.ts
   body: JSON.stringify({
     platform: "teams",
     meeting_url: input.meetingUrl,
     bot_name: input.botName,
     transcribe_enabled: false,
     record_video: true, // TEST if Vexa confirms this flag exists
   })
   ```

3. **Verify against different meeting types:**
   - Scheduled vs ad-hoc meetings
   - Meetings with active screen sharing
   - Meetings with multiple participants

4. **Consider Microsoft Graph fallback:**
   - Requires tenant admin to grant recording permissions
   - See "Alternative: Microsoft Graph Cloud Recording" section above
   - Defer to separate PR if Vexa path fails

### Product Decision

**Current State:**
- Audio recording: ✅ Working in production
- Video recording: ❌ Not available from Vexa
- Architecture: ✅ Ready for video when available
- Feature flag: ✅ Default OFF (honest about capabilities)

**Owner determines:**
- GO: Keep flag OFF until Vexa video confirmed, merge PR for audio improvements
- INVESTIGATE: Contact Vexa support about video recording
- FALLBACK: Pursue Microsoft Graph cloud recording path if needed

## Appendix: Vexa Documentation References

Based on code comments:
- API endpoint: `GET /recordings?meeting_id={numeric_id}` (confirmed working)
- Bot creation: `POST /bots` with `meeting_url` (no video flags documented in code)
- Recording investigation: `packages/meeting-bots/src/vexa/recordings.ts:19-37`

No additional Vexa documentation found in repository.
