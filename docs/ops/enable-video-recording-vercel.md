# Teams Video Recording Setup for E2E Testing

## Overview

Microsoft Teams cloud video recording integration enables automatic ingestion of meeting recordings from Microsoft Graph after meetings complete. This document covers how to enable video recording in Vercel for E2E testing.

## Prerequisites

1. ✅ PR #27 merged to `p3-production-readiness` (Graph recording API + schema migration)
2. ✅ Microsoft Tenant Admin has granted:
   - `OnlineMeetings.Read.All` (application permission)
   - `OnlineMeetingRecording.Read.All` (application permission)
3. ✅ Schema migration `20260912250001_meetings_online_meeting_id.sql` applied to database
4. ✅ Calendar sync is populating `meetings.online_meeting_id` from Graph events

## Feature Flag: ENABLE_VIDEO_RECORDING

### Default State
```bash
ENABLE_VIDEO_RECORDING=false  # Default - video recording is DISABLED
```

Video recording integration is behind a feature flag to allow safe rollout. When disabled, only audio recordings (via Vexa bot) are ingested.

### Enable for E2E Testing (Vercel)

#### Step 1: Set Environment Variable in Vercel

1. Go to Vercel Project Settings → Environment Variables
2. Add new variable:
   - **Name**: `ENABLE_VIDEO_RECORDING`
   - **Value**: `true`
   - **Environments**: Choose target environment (Production / Preview / Development)
3. Save changes
4. **Important**: Redeploy the application for changes to take effect

```bash
# Via Vercel CLI (alternative)
vercel env add ENABLE_VIDEO_RECORDING production
# When prompted, enter: true
```

#### Step 2: Verify Feature Flag

Check the application reads the flag correctly:

```bash
# In application logs or via API
curl https://your-app.vercel.app/api/internal/health \
  -H "Authorization: Bearer YOUR_INTERNAL_TOKEN"
# Should show enableVideoRecording: true in response
```

#### Step 3: Trigger Video Recording Ingestion

Video recordings are ingested **after** meetings complete. There are two ways to trigger ingestion:

##### Option A: Automatic (Scheduled Cron)

If you have Vercel Cron configured:

```json
// vercel.json
{
  "crons": [{
    "path": "/api/internal/video-recordings/ingest",
    "schedule": "*/15 * * * *"  // Every 15 minutes
  }]
}
```

##### Option B: Manual Trigger (For Testing)

```bash
# Ingest video for a specific meeting (for immediate E2E testing)
curl -X POST https://your-app.vercel.app/api/internal/video-recordings/ingest \
  -H "Authorization: Bearer YOUR_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"meetingId": "YOUR_MEETING_UUID"}'
```

Response format:
```json
{
  "results": [{
    "meetingId": "...",
    "status": "success",  // or "skipped_dnr", "not_ready", "already_exists", "error"
    "message": "..."
  }]
}
```

## E2E Testing Workflow

### Test Scenario: Owner Recorded Teams Meeting

1. **Setup**:
   - Set `ENABLE_VIDEO_RECORDING=true` in Vercel
   - Ensure meeting has `online_meeting_id` populated from calendar sync
   - Confirm no DNR (Do Not Record) policy applies to meeting participants

2. **Join Meeting**:
   - Owner (ramakrishna@applywizz.ai) starts Teams meeting
   - **Click "Record" button** in Teams (Graph only captures recordings that were actually started)
   - Vexa bot joins for audio capture (existing path)

3. **Complete Meeting**:
   - End Teams meeting
   - Recording processes in Teams (typically 5-10 minutes)

4. **Trigger Video Ingestion** (15 min after meeting ends):
   ```bash
   # Option 1: Wait for cron (if configured)
   # Option 2: Manual trigger
   curl -X POST https://your-app.vercel.app/api/internal/video-recordings/ingest \
     -H "Authorization: Bearer YOUR_INTERNAL_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"meetingId": "MEETING_UUID_FROM_DB"}'
   ```

5. **Verify**:
   ```sql
   -- Check meeting_recordings table
   SELECT 
     m.title,
     mr.media_kind,
     mr.byte_size,
     mr.source_provider
   FROM meetings m
   LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id
   WHERE m.id = 'YOUR_MEETING_UUID'
   ORDER BY mr.media_kind;
   
   -- Expected output:
   -- | title             | media_kind | byte_size | source_provider |
   -- | E2E Test Meeting  | audio      | 2500000   | vexa            |
   -- | E2E Test Meeting  | video      | 48000000  | microsoft-graph |
   ```

## DNR (Do Not Record) Behavior

When `ENABLE_VIDEO_RECORDING=true`:

- ✅ **DNR applies to BOTH audio and video**
- If meeting has `eligibility_status='exclude'` (DNR participant detected):
  - Vexa bot is NOT scheduled (existing behavior)
  - Video ingestion is SKIPPED
  - Audit log: `recording.video_ingestion_skipped_dnr`

### Test DNR Enforcement

1. Add test domain to DNR policy (e.g., `@no-record-test.example`)
2. Create meeting with DNR participant
3. After meeting completes, trigger video ingestion
4. Verify:
   ```sql
   -- No recordings should exist
   SELECT COUNT(*) FROM meeting_recordings WHERE meeting_id = 'DNR_MEETING_UUID';
   -- Expected: 0
   
   -- Audit log should show DNR enforcement
   SELECT action, metadata 
   FROM audit_events 
   WHERE entity_id = 'DNR_MEETING_UUID' 
     AND action = 'recording.video_ingestion_skipped_dnr';
   ```

## Troubleshooting

### Video Ingestion Returns "not_ready"

**Cause**: Graph recording not yet available (processing takes 5-10 min after meeting ends)

**Solution**: Wait longer and retry. Graph polls up to 6 times (12 min total) before giving up.

### Video Ingestion Returns "skipped_no_online_id"

**Cause**: Meeting missing `online_meeting_id`

**Check**:
```sql
SELECT id, online_meeting_id, meeting_url 
FROM meetings 
WHERE id = 'YOUR_MEETING_UUID';
```

**Fix**: Ensure calendar sync is running and includes `onlineMeeting.id` from Graph API

### Permission Denied (Graph API 403)

**Cause**: Admin consent not granted for video recording permissions

**Fix**: Tenant admin must grant in Azure Portal:
- `OnlineMeetings.Read.All` (application)
- `OnlineMeetingRecording.Read.All` (application)

### Recording Already Exists Error

**Cause**: Video was already ingested (idempotency check)

**Solution**: This is expected behavior. Video ingestion is idempotent - calling twice is safe.

## Security Notes

1. **Feature Flag Required**: Video recording ONLY happens when `ENABLE_VIDEO_RECORDING=true`
2. **DNR Enforced**: If any participant has DNR policy, video is NOT ingested
3. **App-Only Credentials**: Video ingestion uses application permissions (not delegated user auth)
4. **Best-Effort**: Video ingestion failures never block audio transcription path

## Production Rollout (When Ready)

1. Confirm E2E testing successful
2. Set `ENABLE_VIDEO_RECORDING=true` in production Vercel
3. Monitor initial recordings:
   ```sql
   -- Track video ingestion success rate
   SELECT 
     COUNT(*) FILTER (WHERE action = 'recording.video_ingestion_success') as success_count,
     COUNT(*) FILTER (WHERE action = 'recording.video_ingestion_error') as error_count,
     COUNT(*) FILTER (WHERE action = 'recording.video_ingestion_skipped_dnr') as dnr_count
   FROM audit_events
   WHERE action LIKE 'recording.video_%'
     AND created_at > NOW() - INTERVAL '24 hours';
   ```
4. Verify storage costs (video files are ~20-50MB vs ~2-5MB audio)
5. Adjust cron frequency if needed (default: 15 min)

## References

- PR #27: Graph cloud recording API implementation
- Spike: `docs/product/graph-cloud-recording-spike.md`
- E2E Checklist: `docs/ops/graph-cloud-recording-e2e-checklist.md`
