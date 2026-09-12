#!/usr/bin/env tsx

/**
 * P3: Vexa Video Recording Spike Script
 * 
 * Manual verification script to test if Vexa returns video media files
 * for Teams bot recordings. Run this against production Vexa API.
 * 
 * Prerequisites:
 * - Access to production Vexa API key
 * - A completed Teams meeting with screen sharing
 * - Vexa meeting ID from that session (numeric, from bot creation response)
 * 
 * Usage:
 *   VEXA_API_KEY=<key> VEXA_MEETING_ID=<numeric-id> npm run spike:vexa-video
 * 
 * Or directly:
 *   VEXA_API_KEY=<key> VEXA_MEETING_ID=<numeric-id> tsx scripts/vexa-video-spike.ts
 * 
 * Expected outcomes:
 * 1. PASS: Response includes media_files[] with type: "video"
 * 2. FAIL: Only type: "audio" present → video not captured
 * 3. ERROR: API access issues
 */

interface MediaFile {
  id?: number;
  type?: string;
  format?: string;
  is_final?: boolean;
  file_size_bytes?: number;
  duration_seconds?: number;
}

interface Recording {
  id?: number;
  status?: string;
  media_files?: MediaFile[];
}

interface RecordingsResponse {
  recordings?: Recording[];
}

async function spikeVexaVideo(): Promise<void> {
  const apiKey = process.env.VEXA_API_KEY;
  const meetingId = process.env.VEXA_MEETING_ID;
  const baseUrl = process.env.VEXA_BASE_URL || "https://api.vexa.ai/v1";

  if (!apiKey) {
    console.error("❌ ERROR: VEXA_API_KEY environment variable not set");
    process.exit(1);
  }

  if (!meetingId) {
    console.error("❌ ERROR: VEXA_MEETING_ID environment variable not set");
    process.exit(1);
  }

  const numericMeetingId = Number(meetingId);
  if (!Number.isFinite(numericMeetingId)) {
    console.error(`❌ ERROR: VEXA_MEETING_ID must be a numeric value, got: ${meetingId}`);
    process.exit(1);
  }

  console.log("🔍 Vexa Video Recording Spike");
  console.log("================================");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Meeting ID: ${numericMeetingId}`);
  console.log("");

  try {
    const url = `${baseUrl}/recordings?meeting_id=${numericMeetingId}`;
    console.log(`📡 Calling: GET ${url}`);
    console.log("");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`❌ API ERROR: HTTP ${response.status}`);
      console.error(`Response: ${body}`);
      process.exit(1);
    }

    const data: RecordingsResponse = await response.json();
    console.log("📦 Raw Response:");
    console.log(JSON.stringify(data, null, 2));
    console.log("");

    if (!data.recordings || data.recordings.length === 0) {
      console.log("⚠️  RESULT: No recordings found for this meeting ID");
      console.log("   This might mean:");
      console.log("   - Meeting ID is incorrect");
      console.log("   - Recording is still processing");
      console.log("   - Bot never completed the session");
      process.exit(0);
    }

    console.log(`✅ Found ${data.recordings.length} recording(s)`);
    console.log("");

    let foundVideo = false;
    let foundAudio = false;

    for (let i = 0; i < data.recordings.length; i++) {
      const recording = data.recordings[i];
      console.log(`Recording #${i + 1}:`);
      console.log(`  ID: ${recording.id}`);
      console.log(`  Status: ${recording.status}`);
      console.log(`  Media files: ${recording.media_files?.length || 0}`);
      console.log("");

      if (recording.media_files) {
        for (const mediaFile of recording.media_files) {
          const type = mediaFile.type || "unknown";
          const sizeLabel = mediaFile.file_size_bytes
            ? `${(mediaFile.file_size_bytes / 1024 / 1024).toFixed(2)} MB`
            : "size unknown";
          const durationLabel = mediaFile.duration_seconds
            ? `${Math.round(mediaFile.duration_seconds)}s`
            : "duration unknown";

          console.log(`  Media File:`);
          console.log(`    ID: ${mediaFile.id}`);
          console.log(`    Type: ${type}`);
          console.log(`    Format: ${mediaFile.format || "unknown"}`);
          console.log(`    Size: ${sizeLabel}`);
          console.log(`    Duration: ${durationLabel}`);
          console.log(`    Final: ${mediaFile.is_final ?? "unknown"}`);
          console.log("");

          if (type === "audio") foundAudio = true;
          if (type === "video") foundVideo = true;
        }
      }
    }

    console.log("================================");
    console.log("📊 SPIKE RESULT:");
    console.log("");

    if (foundVideo && foundAudio) {
      console.log("✅ PASS: Vexa provides BOTH audio AND video media files");
      console.log("   → Video recording E2E feature is READY");
      console.log("   → Set ENABLE_VIDEO_RECORDING=true in production");
      console.log("   → Update landing page copy to mention screen recording");
    } else if (foundAudio && !foundVideo) {
      console.log("⚠️  PARTIAL: Vexa provides audio ONLY (no video)");
      console.log("   → Video recording architecture is implemented");
      console.log("   → BUT Vexa does not capture video for this bot config");
      console.log("   → Keep ENABLE_VIDEO_RECORDING=false (default)");
      console.log("   → Investigate:");
      console.log("     • Bot creation flags (need recording_video: true??)");
      console.log("     • Vexa account tier (video requires upgrade?)");
      console.log("     • Meeting type (only works for specific scenarios?)");
    } else if (foundVideo && !foundAudio) {
      console.log("❌ UNEXPECTED: Vexa provides video WITHOUT audio");
      console.log("   → This should not happen (audio is always expected)");
      console.log("   → Investigate bot configuration or Vexa API response");
    } else {
      console.log("❌ FAIL: No audio OR video media files found");
      console.log("   → Check if recording completed successfully");
      console.log("   → Verify meeting ID is correct");
    }

    console.log("");
    console.log("================================");
    console.log("");
    console.log("📝 Next Steps:");
    console.log("  1. Document findings in docs/product/screen-recording-spike.md");
    console.log("  2. Update E2E checklist in PR description");
    console.log("  3. If video available: enable feature flag and test in staging");
    console.log("  4. If video unavailable: keep feature flag OFF, architecture is ready for future");
    console.log("");

  } catch (error) {
    console.error("❌ UNEXPECTED ERROR:");
    console.error(error);
    process.exit(1);
  }
}

// Run the spike
spikeVexaVideo().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
