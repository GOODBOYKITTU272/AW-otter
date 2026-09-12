# E2E Testing Checklist: Microsoft Graph Cloud Recording

**Date:** 2026-09-12  
**Feature:** Graph Teams cloud recording video ingestion  
**Target:** Production readiness validation  
**Owner:** ramakrishna@applywizz.ai

---

## Prerequisites (Complete Before Testing)

### 1. Admin Consent (REQUIRED)

✅ **Action**: Grant application permissions in Azure Portal

**Steps:**
1. Log in to https://portal.azure.com as ramakrishna@applywizz.ai
2. Navigate to: Azure Active Directory → App registrations
3. Find app: `applywizz-echo` (or create if not exists)
4. Go to: API permissions blade
5. Click: "Add a permission" → Microsoft Graph → Application permissions
6. Search and select:
   - `OnlineMeetings.Read.All`
   - `OnlineMeetingRecording.Read.All`
7. Click: "Grant admin consent for [tenant name]"
8. Verify: Both permissions show green checkmark in "Status" column

**Validation:**
```bash
# Test application token includes new scopes
curl -X POST "https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id={client_id}" \
  -d "client_secret={client_secret}" \
  -d "grant_type=client_credentials" \
  -d "scope=https://graph.microsoft.com/.default"

# Decode access_token at https://jwt.ms
# Verify "roles" claim includes:
# - "OnlineMeetings.Read.All"
# - "OnlineMeetingRecording.Read.All"
```

---

### 2. Teams Admin Policy (OPTIONAL - Recommended)

✅ **Action**: Enable auto-record policy for Account Managers

**Why**: Eliminates "forgot to record" user error. If not enabled, AMs must manually click "Record" in Teams.

**Steps:**
1. Log in to: https://admin.teams.microsoft.com as Teams admin
2. Navigate to: Meetings → Meeting policies
3. Create new policy: "ApplyWizz Echo Auto-Record"
4. Settings:
   - Cloud recording: `On, user can override`
   - Automatic recording: `On` (if available)
5. Assign policy to: Account Managers group/users

**Alternative (Manual Recording):**
- Document in user onboarding: "Click 'Record' button in Teams before your client call"
- Recording indicator will show for all participants (required for consent)

---

### 3. Environment Variables

✅ **Action**: Set environment variables for Graph API access

**Required Variables:**
```bash
# Azure Portal → App registrations → applywizz-echo
MICROSOFT_TENANT_ID=<tenant_guid>
MICROSOFT_CLIENT_ID=<app_client_id>
MICROSOFT_CLIENT_SECRET=<app_client_secret>

# Feature flag (default: false)
ENABLE_VIDEO_RECORDING=true
```

**Deployment:**
- Staging: Set via environment config
- Production: Set after successful staging validation

---

### 4. Schema Migration

✅ **Action**: Run migration to add `online_meeting_id` column

**Migration File:** `supabase/migrations/20260912250001_meetings_online_meeting_id.sql`

**Validation:**
```sql
-- Verify column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'meetings' AND column_name = 'online_meeting_id';

-- Expected output:
-- online_meeting_id | text | YES

-- Verify index exists
SELECT indexname
FROM pg_indexes
WHERE tablename = 'meetings' AND indexname = 'meetings_online_meeting_id_idx';

-- Expected output:
-- meetings_online_meeting_id_idx
```

---

## Test Scenarios

### Test 1: Single AM - Manual Recording (Smoke Test)

**Goal**: Verify end-to-end flow with one Account Manager manually recording

**Setup:**
1. AM: One Account Manager (you or test user)
2. Client: One external participant
3. Meeting: Schedule 15-minute Teams meeting
4. Recording: AM manually clicks "Record" in Teams

**Expected Flow:**
1. ✅ Meeting scheduled, appears in Echo UI
2. ✅ Vexa bot joins meeting automatically (existing audio flow)
3. ✅ AM clicks "Record" in Teams
4. ✅ Recording indicator shows for all participants
5. ✅ Meeting ends
6. ✅ Vexa audio available within ~5 min (existing flow)
7. ✅ Graph video available within ~10 min (new flow)
8. ✅ Meeting Detail shows both audio AND video players

**Validation SQL:**
```sql
-- Check meeting has online_meeting_id populated
SELECT id, title, online_meeting_id, scheduled_start
FROM meetings
WHERE title ILIKE '%[your test meeting title]%'
ORDER BY scheduled_start DESC
LIMIT 1;

-- Check both audio AND video recordings exist
SELECT
  m.title,
  mr.media_kind,
  mr.source_provider,
  mr.byte_size / 1024 / 1024 AS size_mb,
  mr.created_at
FROM meetings m
JOIN meeting_recordings mr ON mr.meeting_id = m.id
WHERE m.title ILIKE '%[your test meeting title]%'
ORDER BY mr.media_kind;

-- Expected output (2 rows):
-- | title      | media_kind | source_provider   | size_mb | created_at          |
-- |------------|------------|-------------------|---------|---------------------|
-- | Test Call  | audio      | vexa              | 2.5     | 2026-09-12 14:05:00 |
-- | Test Call  | video      | microsoft-graph   | 125.3   | 2026-09-12 14:10:00 |
```

**UI Validation:**
1. Navigate to Meeting Detail page for test meeting
2. Verify video player appears at top
3. Click play on video player
4. Verify video plays with both screen share + participant video visible
5. Scroll down, verify audio player still exists (for transcript/audio-only use case)

**PASS Criteria:**
- ✅ Both SQL rows exist (audio + video)
- ✅ Video file size > 50 MB (reasonable for 15-min recording)
- ✅ Video player renders and plays successfully
- ✅ Audio player still works (no regression)

---

### Test 2: Auto-Record Policy (7 AMs)

**Goal**: Verify scale with multiple AMs using auto-record policy

**Setup:**
1. AMs: 7 Account Managers with auto-record policy enabled
2. Clients: Each AM has different client meeting
3. Schedule: All meetings within same day
4. Recording: Automatic (no manual "Record" click needed)

**Expected Flow:**
1. ✅ All 7 meetings scheduled
2. ✅ Vexa bots join all 7 meetings
3. ✅ Recordings start automatically (policy)
4. ✅ All 7 meetings complete
5. ✅ All 7 audio recordings available (~5 min each)
6. ✅ All 7 video recordings available (~10 min each)

**Validation SQL:**
```sql
-- Check all 7 meetings have online_meeting_id
SELECT
  COUNT(*) AS meetings_with_online_id
FROM meetings
WHERE scheduled_start > now() - interval '1 day'
  AND online_meeting_id IS NOT NULL
  AND eligibility_status = 'record';

-- Expected: 7

-- Check all 7 have both audio AND video recordings
SELECT
  media_kind,
  COUNT(*) AS recording_count
FROM meeting_recordings mr
JOIN meetings m ON m.id = mr.meeting_id
WHERE m.scheduled_start > now() - interval '1 day'
  AND m.eligibility_status = 'record'
GROUP BY media_kind
ORDER BY media_kind;

-- Expected output:
-- | media_kind | recording_count |
-- |------------|-----------------|
-- | audio      | 7               |
-- | video      | 7               |
```

**PASS Criteria:**
- ✅ 14 total recordings (7 audio + 7 video)
- ✅ All video files > 50 MB
- ✅ No ingestion errors in logs
- ✅ All 7 videos playable in UI

---

### Test 3: No Recording (Expected Behavior)

**Goal**: Verify graceful handling when no recording exists

**Setup:**
1. AM: One Account Manager
2. Meeting: Schedule Teams meeting
3. Recording: Do NOT click "Record", auto-record policy OFF

**Expected Flow:**
1. ✅ Meeting scheduled
2. ✅ Vexa bot joins (audio still works)
3. ✅ Meeting ends
4. ✅ Audio recording available (Vexa)
5. ✅ NO video recording (expected - wasn't recorded)
6. ✅ Meeting Detail shows audio player only (no error)

**Validation SQL:**
```sql
-- Check only audio recording exists (video should be absent)
SELECT
  m.title,
  mr.media_kind
FROM meetings m
LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id
WHERE m.title ILIKE '%[no-record test meeting]%';

-- Expected output (1 row):
-- | title           | media_kind |
-- |-----------------|------------|
-- | No Record Test  | audio      |
```

**Log Validation:**
```bash
# Check logs for video_not_available (NOT video_ingestion_failed)
grep "video_not_available" /path/to/logs

# Should see:
# [INFO] No Graph cloud recording found for meeting_id=..., expected if not recorded
```

**PASS Criteria:**
- ✅ Audio recording exists
- ✅ Video recording does NOT exist (expected)
- ✅ Logs show `video_not_available` (not error)
- ✅ UI shows audio player with no error message

---

### Test 4: DNR Participant Blocks Video

**Goal**: Verify DNR (Do Not Record) policy blocks video ingestion

**Setup:**
1. DNR domain: Add `@no-record-test.example` to DNR list
2. Meeting: AM schedules meeting with participant `client@no-record-test.example`
3. Recording: AM manually clicks "Record" in Teams (Teams allows it, Echo should block)

**Expected Flow:**
1. ✅ Meeting scheduled
2. ✅ Meeting marked `eligibility_status='exclude'` (DNR enforcement)
3. ✅ Vexa bot NOT scheduled (existing DNR behavior)
4. ✅ AM clicks "Record" in Teams (Teams allows - Echo has no control over native recording)
5. ✅ Meeting ends
6. ✅ Graph cloud recording exists (Teams recorded it)
7. ✅ Echo does NOT ingest video (DNR enforcement)
8. ✅ NO audio or video recordings in Echo

**Validation SQL:**
```sql
-- Check NO recordings exist (both audio and video blocked by DNR)
SELECT
  m.title,
  m.eligibility_status,
  COUNT(mr.id) AS recording_count
FROM meetings m
LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id
WHERE m.title ILIKE '%[dnr test meeting]%'
GROUP BY m.id, m.title, m.eligibility_status;

-- Expected output:
-- | title        | eligibility_status | recording_count |
-- |--------------|--------------------|-----------------| 
-- | DNR Test     | exclude            | 0               |
```

**Audit Log Validation:**
```sql
-- Check audit log for DNR enforcement
SELECT
  action,
  metadata->'reason' AS reason
FROM audit_events
WHERE action = 'recording.video_ingestion_skipped_dnr'
  AND entity_type = 'meeting'
ORDER BY created_at DESC
LIMIT 1;

-- Expected output:
-- | action                                | reason                     |
-- |---------------------------------------|----------------------------|
-- | recording.video_ingestion_skipped_dnr | DNR participant detected   |
```

**PASS Criteria:**
- ✅ Zero recordings in Echo (both audio and video blocked)
- ✅ Audit log shows DNR enforcement
- ✅ UI shows "Recording unavailable (privacy policy)" message

---

### Test 5: Large File Handling (1-Hour Meeting)

**Goal**: Verify 500 MB size limit for video downloads

**Setup:**
1. Meeting: Schedule 1-hour Teams meeting
2. Recording: Record full duration
3. Expected size: ~300-400 MB

**Expected Flow:**
1. ✅ Meeting completes (1 hour)
2. ✅ Graph recording processes (~10 min)
3. ✅ Echo job downloads video
4. ✅ Download succeeds (size < 500 MB limit)
5. ✅ Video stored successfully

**Validation SQL:**
```sql
-- Check video file size
SELECT
  m.title,
  mr.byte_size / 1024 / 1024 AS size_mb,
  mr.duration_seconds / 60 AS duration_minutes
FROM meetings m
JOIN meeting_recordings mr ON mr.meeting_id = m.id
WHERE m.title ILIKE '%[1-hour test meeting]%'
  AND mr.media_kind = 'video';

-- Expected output:
-- | title          | size_mb | duration_minutes |
-- |----------------|---------|------------------|
-- | 1-Hour Test    | 350.2   | 60               |
```

**PASS Criteria:**
- ✅ Video file size between 200-500 MB (reasonable for 1 hour)
- ✅ Download completes without timeout
- ✅ Video plays successfully

**Note**: If recording > 500 MB, job will fail with clear error. Document limit for users: "Meetings longer than 90 minutes may exceed video size limit."

---

### Test 6: Retry After Transient Failure

**Goal**: Verify retry logic handles temporary network issues

**Setup:**
1. Meeting: Schedule short meeting with recording
2. Simulate: Network timeout during download (test environment only)

**Expected Flow:**
1. ✅ First attempt: Download timeout after 2 min
2. ✅ Job status: `failed`, error logged
3. ✅ Retry job runs (exponential backoff)
4. ✅ Second attempt: Success, video ingested

**Manual Simulation (Dev/Staging Only):**
```typescript
// Temporarily inject network delay in test environment
// packages/microsoft/src/graph-recording.ts
// Add before download:
await new Promise(resolve => setTimeout(resolve, 130_000)); // Force timeout
```

**PASS Criteria:**
- ✅ Initial failure logged with timeout error
- ✅ Retry succeeds after network restored
- ✅ No duplicate recordings (idempotency check)

---

## Post-Test Validation

### 1. Cost Check

**Azure Blob Storage Costs:**
```bash
# Check total video storage usage
SELECT
  COUNT(*) AS video_count,
  SUM(byte_size) / 1024 / 1024 / 1024 AS total_gb,
  AVG(byte_size) / 1024 / 1024 AS avg_size_mb
FROM meeting_recordings
WHERE media_kind = 'video'
  AND created_at > now() - interval '30 days';

# Expected for 7 AMs, 20 meetings/week:
# ~80 videos/month, ~16 GB, ~$0.33/month storage
```

**Action**: Document actual costs in ops runbook

---

### 2. Monitoring Setup

**CloudWatch Alerts (Production):**
1. `video_ingestion_failed` rate > 10% → Alert owner
2. Video recording count drops to 0 for 24 hours → Alert (policy issue?)
3. Average video download time > 5 minutes → Investigate (network issue?)

**Ops Dashboard Metrics:**
- Video recordings ingested per day
- Success rate (video found / meetings recorded)
- Average file size
- Average ingestion time

---

### 3. User Communication

**Help Article: "How to Record Client Meetings with Video"**

**If Auto-Record Enabled:**
> Your client meetings are automatically recorded with video when you join via Teams. Recordings appear in Echo within 10 minutes of meeting end.

**If Manual Recording Required:**
> To record your client meeting:
> 1. Join Teams meeting
> 2. Click "Record" button (top bar)
> 3. Recording indicator will show for all participants
> 4. Recording appears in Echo within 10 minutes of meeting end

**Privacy Notice:**
> All participants can see when a meeting is being recorded (recording indicator). Recordings are stored securely and subject to your organization's data retention policy.

---

## Rollback Plan

**If Critical Issues Found:**

1. **Disable Feature Flag:**
   ```bash
   ENABLE_VIDEO_RECORDING=false
   ```

2. **Revert Schema (Optional - only if blocking):**
   ```sql
   ALTER TABLE meetings DROP COLUMN online_meeting_id;
   ```

3. **Monitor:**
   - Audio recordings still work (Vexa unaffected)
   - No video ingestion attempts logged

**Note**: Schema revert is optional - column can stay (nullable, no harm) while video feature is disabled by flag.

---

## Success Criteria Summary

✅ **All 6 test scenarios PASS**  
✅ **Zero critical errors in production logs**  
✅ **Cost within expected range (<$1/month for 7 AMs)**  
✅ **User documentation published**  
✅ **Monitoring alerts configured**

**When ALL criteria met → Production deployment approved**

---

## Contact

**Questions/Issues**: ramakrishna@applywizz.ai  
**Slack**: #echo-dev  
**Docs**: `docs/product/graph-cloud-recording-spike.md`

**END OF E2E CHECKLIST**
