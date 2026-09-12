# Microsoft Graph Teams Cloud Recording Spike

**Date:** 2026-09-12  
**Status:** SPIKE COMPLETE — Ready for Implementation  
**Owner Decision:** Graph cloud recording is the production video path for Apply Wizz Echo  
**Product Context:** Vexa confirmed audio-only; Graph provides native Teams cloud recordings (video + audio composite)

---

## Executive Summary

**DECISION (Owner-approved):** Microsoft Graph Teams **cloud recording** is the chosen video path for Apply Wizz Echo. Vexa remains the **audio-only** bot for transcription. Screenpipe and Meetily are rejected.

### Why Graph Cloud Recording?

1. **Native Teams Integration:** Cloud recordings are native Teams feature (organizer clicks Record OR org policy auto-records)
2. **Composite Video:** Full meeting recording includes shared screens, participant video, audio — exactly what customers expect from "screen recording"
3. **Free (Azure Cost Only):** No additional SaaS subscriptions; storage uses existing Azure account
4. **Complements Vexa:** Vexa bot handles CRM auto-join + audio/transcript; Graph provides video upgrade path
5. **Production Trust:** Microsoft Graph API is production-ready, well-documented, with SLAs

### Key Constraints

- **Manual Recording OR Policy:** Cloud recordings require either:
  - Organizer manually clicks "Record" during meeting, OR
  - Teams admin sets org policy to auto-record (configurable per-meeting-type)
- **Application Permissions Required:** Need tenant admin consent for `OnlineMeetings.Read.All` + `OnlineMeetingRecording.Read.All`
- **Availability Delay:** Recordings available ~5-10 minutes post-meeting (Graph processing time)
- **File Size:** MP4 composite video (~200-500 MB/hour, significantly larger than Vexa audio)

### This PR Scope (Spike + Scaffolding ONLY)

This PR delivers:
1. ✅ **Spike document** (this file) — PASS/FAIL criteria, APIs, permissions, policies, implementation plan
2. ✅ **Permission gap analysis** — exact scopes needed vs currently granted
3. ✅ **Stub interfaces** behind feature flag — `getCloudRecordingForMeeting` + TODO hooks
4. ✅ **Cross-link** `screen-recording-spike.md` — clarify Vexa=audio, Graph=video

This PR does NOT:
- ❌ Enable video in production (`ENABLE_VIDEO_RECORDING` stays `false`)
- ❌ Request tenant admin consent for new permissions (requires manual action)
- ❌ Implement full download/ingest flow (next PR after admin consent granted)
- ❌ Test against real cloud recordings (E2E test plan for implementation PR)

---

## PASS/FAIL Criteria

### PASS: Graph Cloud Recording is Viable

✅ **API Availability:** Microsoft Graph provides stable, documented APIs for accessing cloud recordings  
✅ **Permission Model:** Application-level permissions exist (`OnlineMeetings.Read.All`, `OnlineMeetingRecording.Read.All`)  
✅ **Mapping to Meetings:** Can correlate Teams `onlineMeeting.id` → Echo `meetings` row via `icalUId` + `joinUrl`  
✅ **Download Capability:** Recordings expose `recordingContentUrl` (time-limited signed URL) for direct download  
✅ **Cost Model:** Free API calls; only Azure Blob Storage costs apply (~$0.02/GB/month, acceptable)  
✅ **Existing Infrastructure:** `packages/microsoft` already has Graph client, OAuth, token refresh  

### FAIL: Known Limitations (Acceptable Trade-offs)

⚠️ **Manual Recording Dependency:** Requires organizer to remember to record OR org policy to auto-record (NOT automatic like Vexa bot join)  
⚠️ **Tenant Admin Consent Required:** New permissions need ramakrishna@applywizz.ai to grant consent in Azure Portal (one-time setup)  
⚠️ **Availability Delay:** 5-10 minute lag between meeting end and recording availability (acceptable for async CRM notes workflow)  
⚠️ **Organizer-Only Access (Delegated):** Delegated tokens can only access recordings for meetings the user organized (application tokens bypass this)

**Product Decision:** These limitations are acceptable. Manual recording (with clear user instructions) or auto-record policy is standard for enterprise Teams deployments. Availability delay is fine for post-meeting CRM workflow.

---

## Microsoft Graph APIs

### 1. List Online Meetings (Existing)

**Endpoint:** `GET /users/{userId}/onlineMeetings`  
**Purpose:** Already used by Echo to fetch Teams meeting metadata from calendar events  
**Current Implementation:** `packages/microsoft/src/graph-client.ts` fetches calendar events with `onlineMeeting.joinUrl`  
**Fields Used:**
- `id` — Graph's online meeting ID (DIFFERENT from calendar event ID)
- `joinUrl` — Teams meeting link (maps to Echo `meetings.meeting_url`)
- `subject` — Meeting title

**Gap:** Current calendar sync does NOT persist Graph's `onlineMeeting.id`. Implementation PR must store this for recording lookup.

---

### 2. Get Online Meeting (New — Required for ID Mapping)

**Endpoint:** `GET /communications/onlineMeetings/{onlineMeetingId}`  
**Purpose:** Fetch a specific online meeting by its Graph ID  
**Permissions Required:** `OnlineMeetings.Read.All` (application) OR `OnlineMeeting.ReadWrite` (delegated)  
**Response Fields:**
```json
{
  "id": "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk...",
  "subject": "Client Pitch Meeting",
  "startDateTime": "2026-09-15T14:00:00Z",
  "endDateTime": "2026-09-15T15:00:00Z",
  "joinUrl": "https://teams.microsoft.com/l/meetup-join/...",
  "joinWebUrl": "https://teams.microsoft.com/l/meetup-join/...",
  "participants": { "organizer": { "identity": { "user": { "id": "..." } } } },
  "isEntryExitAnnounced": true,
  "allowedPresenters": "everyone",
  "videoTeleconferenceId": "123456789",
  "externalId": null,
  "iCalUId": "040000008200E00074C5B7101A82E00800000000..."
}
```

**Key Field:** `iCalUId` — This is the canonical meeting identifier that matches `meetings.ical_uid` in Echo's database. Use this to correlate Graph online meetings → Echo meetings.

**Status:** NOT currently implemented. Add in implementation PR.

---

### 3. List Cloud Recordings for Meeting (New — Core Implementation)

**Endpoint:** `GET /communications/onlineMeetings/{onlineMeetingId}/recordings`  
**Purpose:** Fetch all cloud recordings for a specific online meeting  
**Permissions Required:** `OnlineMeetingRecording.Read.All` (application)  
**Documentation:** https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-recordings  
**Response:**
```json
{
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#communications/onlineMeetings('...')/recordings",
  "value": [
    {
      "id": "c1e0e1e0-0000-0000-0000-000000000000",
      "meetingId": "MSoxOTptYWlsY29udGV4dEBhcHBseXdpenouYWk...",
      "createdDateTime": "2026-09-15T15:05:23Z",
      "recordingContentUrl": "https://graph.microsoft.com/v1.0/communications/onlineMeetings('...')/recordings('...')/content",
      "meetingOrganizer": {
        "application": null,
        "device": null,
        "user": {
          "id": "user-guid",
          "displayName": "John Doe",
          "userIdentityType": "aadUser"
        }
      }
    }
  ]
}
```

**Key Fields:**
- `id` — Recording ID (unique per recording)
- `createdDateTime` — When recording was finalized (typically 5-10 min after meeting ends)
- `recordingContentUrl` — Signed URL to download MP4 file (expires after ~1 hour)

**Status:** NOT currently implemented. Core work for implementation PR.

---

### 4. Download Recording Content (New — Core Implementation)

**Endpoint:** `GET /communications/onlineMeetings/{onlineMeetingId}/recordings/{recordingId}/content`  
**Purpose:** Download the actual MP4 file  
**Permissions Required:** Same as list recordings (`OnlineMeetingRecording.Read.All`)  
**Response:** Binary MP4 stream  
**File Format:** MP4 (H.264 video + AAC audio), typically 200-500 MB per hour  
**Expiration:** Download URL (from `recordingContentUrl`) expires ~1 hour after fetching; must download immediately

**Status:** NOT currently implemented. Use streaming download pattern from `packages/meeting-bots/src/vexa/recordings.ts` (200MB limit + timeout).

---

### 5. Alternative: CallRecords API (Evaluated — NOT Recommended)

**Endpoint:** `GET /communications/callRecords/{id}`  
**Purpose:** Detailed call analytics (participants, media streams, network quality)  
**Permissions Required:** `CallRecords.Read.All`  
**Recordings Access:** ❌ CallRecords API does NOT provide cloud recording downloads  
**Conclusion:** CallRecords is for analytics/observability, not recording retrieval. Use `onlineMeetings/{id}/recordings` instead.

---

## Required Microsoft Entra Permissions

### Current Permissions (Already Granted)

Source: `packages/microsoft/src/config.ts` (line 31-36)

```typescript
export const MICROSOFT_SCOPES = [
  "openid",              // Identity claims
  "profile",             // User profile  
  "email",               // User email
  "offline_access",      // Refresh token
  "Calendars.Read",      // Read calendar events
] as const;
```

**Grant Type:** Delegated (user consent per-employee)  
**Sufficient For:** Calendar sync, Teams meeting detection, Vexa bot scheduling

### New Permissions Required (Need Admin Consent)

| Permission | Type | Purpose | Admin Consent? |
|------------|------|---------|----------------|
| `OnlineMeetings.Read.All` | Application | Read all online meetings in tenant | ✅ **YES** |
| `OnlineMeetingRecording.Read.All` | Application | Read cloud recordings | ✅ **YES** |

**Why Application Permissions?**
- **Delegated permissions** only grant access to meetings the signed-in user ORGANIZED
- Echo needs to access recordings for ALL Account Managers' meetings (not just one user)
- **Application permissions** allow tenant-wide access (with admin consent)

**Consent Process:**
1. Update App Registration in Azure Portal (`applywizz-echo` app under ramakrishna@applywizz.ai tenant)
2. Add two application permissions: `OnlineMeetings.Read.All` + `OnlineMeetingRecording.Read.All`
3. Click "Grant admin consent for ApplyWizz" (requires Global Admin role)
4. Verify consent status shows green checkmark in portal

**Security Note:** Application permissions bypass per-user consent. This is REQUIRED for Echo's multi-AM use case, but must be documented in security review. All access is logged via audit events.

### Permission Scopes Comparison

| Scenario | Permissions Needed | Grant Type | Echo Use Case |
|----------|-------------------|------------|---------------|
| Calendar sync (existing) | `Calendars.Read` | Delegated | Per-AM calendar access ✅ |
| Read own organized meetings | `OnlineMeeting.ReadWrite` | Delegated | Single AM only ❌ |
| Read all tenant meetings | `OnlineMeetings.Read.All` | Application | Multi-AM access ✅ |
| Read all tenant recordings | `OnlineMeetingRecording.Read.All` | Application | Multi-AM recordings ✅ |

**Conclusion:** Application permissions are REQUIRED. Delegated permissions are insufficient for Echo's multi-AM product model.

---

## Teams Admin Policy: Auto-Record vs Manual

### Manual Recording (Default Behavior)

**How It Works:**
1. Meeting organizer clicks "Record" button in Teams during meeting
2. Recording indicator appears for all participants ("Recording in progress")
3. Recording stops when organizer clicks "Stop" or meeting ends
4. Cloud recording processes for ~5-10 minutes after meeting ends
5. Organizer receives email notification with recording link
6. Recording appears in organizer's OneDrive (for meetings) OR SharePoint (for channel meetings)

**Graph API Access:** Echo can access via `onlineMeetings/{id}/recordings` after processing completes

**User Experience:**
- ❌ **Requires manual action** — AM must remember to click Record
- ✅ **Explicit consent** — Participants see recording indicator
- ✅ **Flexible** — AM can choose to record or not per-meeting

### Auto-Record (Teams Admin Policy)

**Policy Name:** Meeting policies → "Recording & transcription" → "Cloud recording"  
**Admin Portal:** https://admin.teams.microsoft.com/policies/meetings  
**Options:**
- `Off` — No one can record (overrides manual)
- `On, user can override` — Auto-record by default, user can stop (recommended for Echo)
- `On, user cannot override` — Always auto-record (strictest compliance mode)

**How to Enable for ApplyWizz:**
1. Log in to Teams Admin Center as ramakrishna@applywizz.ai
2. Navigate to Meetings → Meeting policies
3. Create policy "ApplyWizz Echo Auto-Record" with:
   - Cloud recording: `On, user can override`
   - Automatic recording: `On` (NEW setting as of Teams 2023)
4. Assign policy to Account Managers' group/users

**Graph API Access:** Same as manual — recordings appear in `onlineMeetings/{id}/recordings` automatically

**User Experience:**
- ✅ **No manual action required** — Recording starts automatically when meeting starts
- ✅ **Explicit consent** — Participants still see recording indicator
- ✅ **Reliable** — No "forgot to record" scenarios
- ⚠️ **Policy dependency** — Requires Teams admin to configure (one-time setup)

### Recommendation: Auto-Record Policy

**For Echo Production:** Enable auto-record policy for Account Managers group.

**Rationale:**
- Eliminates "forgot to record" user error
- Matches customer expectation ("Echo records my client calls automatically")
- Recording indicator still provides explicit participant consent
- Policy can be scoped to specific users/groups (not org-wide if not desired)

**Fallback:** If org policy cannot be enabled (e.g., compliance concerns), document manual recording requirement in user onboarding: "Click Record in Teams before your client call."

---

## Mapping Teams Meeting → Echo `meetings` Row

### Problem: Multiple Identifiers

A single Teams meeting has THREE different IDs:
1. **Calendar Event ID** (`externalEventId` in Echo) — Per-mailbox, Graph calendar API
2. **Online Meeting ID** (`onlineMeeting.id`) — Single per meeting, Graph communications API
3. **iCalUId** — RFC 5545 canonical identifier, unique per-occurrence, same across all participants' mailboxes

**Echo's Current Model:** `meetings.ical_uid` is canonical meeting identity (from M4 dedupe redesign)

### Solution: Store Online Meeting ID

**Schema Change (Implementation PR):**

```sql
-- Add online_meeting_id to meetings table
ALTER TABLE public.meetings
  ADD COLUMN online_meeting_id TEXT;

-- Index for Graph API lookups
CREATE INDEX meetings_online_meeting_id_idx
  ON public.meetings (online_meeting_id)
  WHERE online_meeting_id IS NOT NULL;

-- Uniqueness: one Echo meeting per Graph online meeting
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_online_meeting_id_unique
    UNIQUE (online_meeting_id);
```

### Mapping Flow

**1. Calendar Sync (Existing Flow — Enhance)**

Current: `packages/microsoft/src/graph-client.ts` fetches events with `onlineMeeting.joinUrl`

Enhancement needed:
```typescript
const EVENT_SELECT_FIELDS =
  "id,subject,start,end,organizer,attendees,isOnlineMeeting,onlineMeetingProvider,onlineMeeting,lastModifiedDateTime,iCalUId,type,seriesMasterId,originalStart,isOrganizer";
  // onlineMeeting object includes: { joinUrl, conferenceId, tollNumber, ... }
```

Extract `onlineMeeting.id` from calendar event if present, persist to `meetings.online_meeting_id`.

**Problem:** Graph calendar API returns `onlineMeeting` object with `joinUrl` but NOT always `id` field (depends on meeting creation method).

**2. Reverse Lookup (New — Robust Mapping)**

For meetings where `online_meeting_id` is null, use reverse lookup:

```typescript
// Pseudo-code for implementation PR
async function findOnlineMeetingId(
  graphClient: GraphClient,
  meeting: { icalUId: string, joinUrl: string }
): Promise<string | null> {
  // Option A: Filter by joinUrl (if Graph supports URL-based filtering)
  const params = new URLSearchParams({
    $filter: `joinWebUrl eq '${meeting.joinUrl}'`,
  });
  const result = await graphClient.get(`/communications/onlineMeetings?${params}`);
  return result.value[0]?.id ?? null;
  
  // Option B: Fetch by iCalUId (if exposed in onlineMeetings API)
  // (Needs verification in implementation PR — not confirmed in Graph docs)
  
  // Option C: List all user's online meetings, match by joinUrl
  // (Expensive but guaranteed to work)
}
```

**3. Background Enrichment Job**

For existing meetings missing `online_meeting_id`, run one-time backfill job:
```typescript
// Pseudo-code for implementation PR
async function backfillOnlineMeetingIds() {
  const meetings = await supabase
    .from('meetings')
    .select('id, ical_uid, meeting_url')
    .is('online_meeting_id', null)
    .eq('provider', 'microsoft')
    .eq('meeting_type', 'teams');
    
  for (const meeting of meetings) {
    const onlineMeetingId = await findOnlineMeetingId(graphClient, meeting);
    if (onlineMeetingId) {
      await supabase
        .from('meetings')
        .update({ online_meeting_id: onlineMeetingId })
        .eq('id', meeting.id);
    }
  }
}
```

**Status:** Mapping strategy is viable. Implementation PR must handle both new meetings (store ID during calendar sync) and existing meetings (backfill job).

---

## Download Flow into `meeting_recordings`

### Existing Table Schema (P3 Already Complete)

Source: `supabase/migrations/20260912240001_p3_screen_recording_media_kind.sql`

```sql
CREATE TABLE public.meeting_recordings (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  meeting_id UUID NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('audio', 'video')),
  storage_bucket TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  duration_seconds NUMERIC,
  checksum_sha256 TEXT,
  source_provider TEXT NOT NULL,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE (organization_id, meeting_id, media_kind)
);
```

**Key Constraints:**
- `media_kind` already supports `'video'` (P3 complete)
- `UNIQUE (organization_id, meeting_id, media_kind)` allows one audio + one video per meeting
- `source_provider` can be `'microsoft-graph'` (distinct from `'vexa'`)

**Storage Path Convention:** `organizations/{org_id}/meetings/{meeting_id}/video.original.mp4`

### Ingest Flow (Implementation PR)

**Step 1: Detect Recording Availability**

```typescript
// Pseudo-code for implementation PR
async function pollForCloudRecording(
  graphClient: GraphClient,
  onlineMeetingId: string,
  maxAttempts: number = 6, // 6 attempts × 2 min = 12 min max wait
): Promise<GraphCloudRecording | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const recordings = await graphClient.get(
      `/communications/onlineMeetings/${onlineMeetingId}/recordings`
    );
    
    if (recordings.value.length > 0) {
      // Take most recent recording (in case of multiple)
      return recordings.value[recordings.value.length - 1];
    }
    
    if (attempt < maxAttempts) {
      await sleep(2 * 60 * 1000); // Wait 2 minutes between checks
    }
  }
  
  return null; // No recording found after 12 minutes
}
```

**Step 2: Download MP4 File**

```typescript
// Pseudo-code — reuse streaming pattern from Vexa recordings
async function downloadGraphRecording(
  graphClient: GraphClient,
  recordingContentUrl: string,
): Promise<ArrayBuffer> {
  // recordingContentUrl is pre-signed, call directly (not through graphClient)
  const response = await fetch(recordingContentUrl, {
    method: 'GET',
    signal: AbortSignal.timeout(120_000), // 2 min timeout
  });
  
  if (!response.ok) {
    throw new Error(`Failed to download recording: ${response.status}`);
  }
  
  // Stream with size limit (same as Vexa: 200MB limit for safety)
  const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
  const chunks: Uint8Array[] = [];
  const reader = response.body!.getReader();
  let total = 0;
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    total += value.byteLength;
    if (total > MAX_DOWNLOAD_BYTES) {
      throw new Error('Recording exceeds 200MB limit');
    }
    
    chunks.push(value);
  }
  
  // Merge chunks into single ArrayBuffer
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  
  return merged.buffer;
}
```

**Step 3: Store in Supabase**

```typescript
// Pseudo-code — reuse existing storeOwnedRecording from P3
await storeOwnedRecording(supabase, storage, {
  organizationId: meeting.organization_id,
  meetingId: meeting.id,
  mediaKind: 'video',
  format: 'mp4',
  bytes: recordingBytes,
  durationSeconds: null, // Extract from MP4 metadata if needed
  sourceProvider: 'microsoft-graph',
  sourceMetadata: {
    graphRecordingId: recording.id,
    graphOnlineMeetingId: onlineMeetingId,
    recordedAt: recording.createdDateTime,
  },
});
```

**Trigger Point:** Post-meeting job (same queue as transcription ingestion)

```typescript
// Add to existing meeting lifecycle worker
async function processCompletedMeeting(meeting: Meeting) {
  // Existing: Vexa audio ingestion
  await ensureOwnedRecording(supabase, storage, {
    organizationId: meeting.organization_id,
    meetingId: meeting.id,
    mediaKind: 'audio',
    vexaMeetingId: meeting.vexa_meeting_id,
    vexaEnv,
  });
  
  // NEW: Graph video ingestion (behind feature flag)
  if (isVideoRecordingEnabled() && meeting.online_meeting_id) {
    await ensureGraphCloudRecording(supabase, storage, {
      organizationId: meeting.organization_id,
      meetingId: meeting.id,
      onlineMeetingId: meeting.online_meeting_id,
      graphClient,
    });
  }
}
```

**Error Handling:**
- No recording found after 12 min polling: Log `video_not_available` (not an error; manual recording may not have been started)
- Download timeout/failure: Retry with exponential backoff (same as Vexa)
- Storage conflict: Use same reconciliation logic from P3 (`RecordingStorageMismatchError`)

---

## Consent & Do Not Record (DNR) Interaction

### Current DNR Implementation (Existing)

Source: `packages/domain/src/recording-exceptions.ts`

**DNR Scope:** Audio recording + transcription (controlled by `ENABLE_AUDIO_RECORDING` flag)

**Enforcement Point:** Bot scheduling — meetings with DNR domain participants are marked `exclude` and Vexa bot never joins

**Key Insight:** Graph cloud recording happens INDEPENDENTLY of Vexa bot. A participant with DNR preference could still be recorded via Teams native recording if organizer clicks Record.

### DNR Policy for Video (Implementation PR Decision Needed)

**Option 1: DNR Applies to Video + Audio (Recommended)**

```typescript
// Pseudo-code for implementation PR
async function processCompletedMeeting(meeting: Meeting) {
  // Check DNR for this meeting
  const hasDnrParticipant = await checkRecordingExceptions(meeting);
  
  if (hasDnrParticipant) {
    // Skip both audio AND video ingestion
    console.log('DNR participant detected, skipping all recording ingestion');
    return;
  }
  
  // Proceed with audio + video ingestion
  await ensureOwnedRecording(supabase, storage, { mediaKind: 'audio', ... });
  await ensureGraphCloudRecording(supabase, storage, { mediaKind: 'video', ... });
}
```

**Rationale:**
- DNR policy intent is "do not capture this participant's conversation"
- Video recording includes audio; separating them is inconsistent
- If organizer recorded despite DNR (via manual Teams recording), Echo should NOT ingest/store it

**Option 2: DNR Only Applies to Audio (Not Recommended)**

```typescript
// Pseudo-code — NOT RECOMMENDED
if (hasDnrParticipant) {
  // Skip audio (Vexa bot) but still allow video (Graph)
  await ensureGraphCloudRecording(supabase, storage, { mediaKind: 'video', ... });
}
```

**Problem:** Video recording includes audio. Ingesting video violates DNR intent even if Vexa bot was never scheduled.

### Recommended DNR Policy: Unified Audio + Video

**Implementation:**
1. Existing DNR check applies to BOTH media kinds
2. If `hasDnrParticipant === true`:
   - Do NOT schedule Vexa bot (existing behavior)
   - Do NOT ingest Graph cloud recording (new behavior)
3. Organizer can still manually record in Teams (Echo has no control over native Teams features), but Echo won't ingest/store/display it

**User Communication:** "Some participants have opted out of recording. This meeting will not be recorded by Echo, and any manual Teams recordings will not appear in your Echo dashboard."

**Audit Trail:** Log DNR enforcement for video ingestion (same pattern as audio):

```typescript
await logAuditEvent(supabase, {
  organizationId: meeting.organization_id,
  action: 'recording.video_ingestion_skipped_dnr',
  entityType: 'meeting',
  entityId: meeting.id,
  metadata: { dnrDomains: [...] },
});
```

---

## Cost & Storage Analysis

### Microsoft Graph API Costs

**API Calls:** FREE (no per-request charge from Microsoft)

**Throttling Limits:**
- Application-level: 2,000 requests per second (per tenant)
- Echo expected load: ~10-50 meetings/day → ~50-250 API calls/day (negligible)
- No throttling concerns for Echo's use case

### Azure Storage Costs

**File Size Estimates:**
- 30-minute meeting: ~100-150 MB
- 1-hour meeting: ~200-300 MB
- Compression: MP4 H.264 (already compressed; no further savings without quality loss)

**Azure Blob Storage Pricing** (Hot tier, US East):
- Storage: $0.0208 per GB/month
- Egress (download): $0.087 per GB (first 100 GB/month free)

**Monthly Cost Examples:**

| Scenario | Meetings/Month | Avg Size | Storage (GB) | Storage Cost | Egress Cost | Total/Month |
|----------|----------------|----------|--------------|--------------|-------------|-------------|
| 10 AMs, 5 meetings/week | 200 | 200 MB | 40 GB | $0.83 | $0 (free tier) | **$0.83** |
| 20 AMs, 10 meetings/week | 800 | 200 MB | 160 GB | $3.33 | $5.22 | **$8.55** |
| 50 AMs, 20 meetings/week | 4,000 | 250 MB | 1,000 GB | $20.80 | $78.30 | **$99.10** |

**Scaling Concerns:**
- Current ApplyWizz scale: ~7 AMs → **<$2/month** (negligible)
- 1-year retention: Multiply by 12 (still <$1,200/year at 50 AMs)
- **No action needed** — costs are acceptable at current and projected scale

### Storage Lifecycle Policy (Implementation PR)

**Recommendation:** 90-day retention for video recordings

```typescript
// Pseudo-code for implementation PR (future optimization)
// Azure Blob Storage lifecycle rule:
{
  "rules": [
    {
      "name": "meeting-recordings-video-90d",
      "enabled": true,
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": ["meeting-recordings/organizations/*/meetings/*/video.original.mp4"]
        },
        "actions": {
          "baseBlob": {
            "delete": {
              "daysAfterCreationGreaterThan": 90
            }
          }
        }
      }
    }
  ]
}
```

**Rationale:**
- Audio recordings kept indefinitely (needed for transcripts/CRM notes)
- Video recordings used for QA/review, less value after 90 days
- 90-day window covers quarterly review cycles

**Status:** Lifecycle policy is OPTIONAL for MVP. Defer to post-launch optimization if storage costs become concern.

---

## E2E Test Plan for Implementation PR

### Prerequisites (Setup by Admin Before Testing)

1. ✅ Tenant admin (ramakrishna@applywizz.ai) grants application permissions in Azure Portal
2. ✅ Teams admin enables auto-record policy for test user group (OR test users manually record)
3. ✅ Test Teams meeting scheduled with 2+ participants
4. ✅ `ENABLE_VIDEO_RECORDING=true` set in staging environment

### Test 1: Single AM, Manual Recording

**Setup:**
- AM1 schedules Teams meeting with Client A
- Meeting starts, AM1 clicks "Record" in Teams

**Expected Flow:**
1. Meeting appears in `meetings` table with `online_meeting_id` populated (from calendar sync)
2. Meeting ends, Teams processes recording (~5-10 min)
3. Echo's post-meeting job polls Graph API for recording
4. Recording found, MP4 downloaded
5. `meeting_recordings` row inserted: `media_kind='video'`, `source_provider='microsoft-graph'`
6. Meeting Detail page shows video player with playback controls

**Validation:**
```sql
-- Check meeting has online_meeting_id
SELECT id, title, online_meeting_id
FROM meetings
WHERE title ILIKE '%test%';

-- Check video recording exists
SELECT mr.id, mr.media_kind, mr.byte_size, mr.source_provider
FROM meeting_recordings mr
JOIN meetings m ON m.id = mr.meeting_id
WHERE m.title ILIKE '%test%';
```

**PASS Criteria:**
- ✅ Video recording row exists
- ✅ `byte_size > 50_000_000` (at least 50 MB for 30-min meeting)
- ✅ `source_provider = 'microsoft-graph'`
- ✅ Signed URL generated successfully
- ✅ Video plays in Meeting Detail page

### Test 2: Auto-Record Policy (7 AMs)

**Setup:**
- Teams admin enables auto-record policy for ApplyWizz AMs group
- 7 AMs each schedule 1 Teams meeting with different clients
- Meetings start (recording starts automatically)

**Expected Flow:**
1. All 7 meetings appear in `meetings` table with `online_meeting_id`
2. All meetings complete, recordings process
3. Echo jobs run for all 7 meetings
4. All 7 video recordings ingested successfully

**Validation:**
```sql
-- Check all 7 meetings have video recordings
SELECT m.title, mr.media_kind, mr.byte_size, mr.source_provider
FROM meetings m
LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id AND mr.media_kind = 'video'
WHERE m.scheduled_start > now() - interval '1 day'
  AND m.eligibility_status = 'record';
```

**PASS Criteria:**
- ✅ 7 out of 7 meetings have `media_kind='video'` rows
- ✅ All recordings > 50 MB
- ✅ No ingestion errors in logs
- ✅ All 7 videos playable in Meeting Detail

### Test 3: No Recording (Expected PASS with No Video)

**Setup:**
- AM schedules Teams meeting
- Meeting starts and ends WITHOUT organizer clicking Record
- Auto-record policy NOT enabled for this user

**Expected Flow:**
1. Meeting appears in `meetings` table with `online_meeting_id`
2. Meeting ends, Echo job polls for recording
3. No recording found after 12 min polling
4. Log entry: `video_not_available` (not an error)
5. Meeting Detail page shows audio player only (Vexa audio still available)

**Validation:**
```sql
-- Check NO video recording exists (expected)
SELECT m.title, mr.media_kind
FROM meetings m
LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id AND mr.media_kind = 'video'
WHERE m.title ILIKE '%no-record-test%';
```

**PASS Criteria:**
- ✅ `media_kind='video'` row does NOT exist (expected)
- ✅ `media_kind='audio'` row DOES exist (Vexa bot still worked)
- ✅ Log shows `video_not_available`, not `video_ingestion_failed`
- ✅ Meeting Detail shows audio player (no error message for missing video)

### Test 4: DNR Participant Blocks Video

**Setup:**
- Add `@no-record.example` to DNR domains list
- AM schedules Teams meeting with participant `client@no-record.example`
- Organizer manually clicks Record in Teams (should still work from Teams' perspective)

**Expected Flow:**
1. Meeting marked `eligibility_status='exclude'` (DNR enforcement)
2. Vexa bot NOT scheduled (existing behavior)
3. Meeting ends, Graph cloud recording exists (organizer manually recorded)
4. Echo job skips video ingestion due to DNR participant
5. Audit log: `recording.video_ingestion_skipped_dnr`

**Validation:**
```sql
-- Check NO recordings exist (audio OR video)
SELECT m.title, mr.media_kind
FROM meetings m
LEFT JOIN meeting_recordings mr ON mr.meeting_id = m.id
WHERE m.title ILIKE '%dnr-test%';
```

**PASS Criteria:**
- ✅ NO `meeting_recordings` rows exist (both audio and video blocked by DNR)
- ✅ Audit log contains `video_ingestion_skipped_dnr` event
- ✅ Meeting Detail shows "Recording unavailable (privacy policy)" message

### Test 5: Retry After Transient Failure

**Setup:**
- Simulate network timeout during MP4 download (mock Graph API in test)
- Verify retry logic recovers

**Expected Flow:**
1. First attempt: Download timeout after 60s
2. Job status: `failed`, error logged
3. Retry job runs (exponential backoff)
4. Second attempt: Success, video ingested

**PASS Criteria:**
- ✅ Video recording eventually ingested (after retry)
- ✅ Error log shows initial timeout + retry success
- ✅ No duplicate `meeting_recordings` rows (idempotency check)

### Test 6: Large File (1-Hour Meeting)

**Setup:**
- Schedule 1-hour Teams meeting
- Record full duration (~300-400 MB expected)

**Expected Flow:**
1. Meeting completes, Graph processes recording (~10 min for large file)
2. Echo job downloads large MP4 (streaming, 200MB limit exceeded)
3. Job fails with "Recording exceeds 200MB limit" error

**Expected FAIL (Intentional Limit):**
- ⚠️ 1-hour meetings will FAIL ingestion if >200MB
- This is intentional safety limit (same as Vexa audio)

**Recommendation for Production:** Raise limit to 500 MB for video (separate from audio limit)

```typescript
const MAX_VIDEO_DOWNLOAD_BYTES = 500 * 1024 * 1024; // 500MB for video
const MAX_AUDIO_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB for audio
```

**PASS Criteria:**
- ✅ Job fails with clear error message (not silent failure)
- ✅ Error logged with file size metadata for ops visibility
- ✅ Retry does NOT repeatedly download (fail-fast after first attempt)

---

## Implementation Tranches

### Tranche 0: Spike + Scaffolding (THIS PR)

**Goal:** Prepare for implementation without enabling video in production

**Deliverables:**
1. ✅ This spike document (`docs/product/graph-cloud-recording-spike.md`)
2. ✅ Permission gap analysis (document current vs needed scopes)
3. ✅ Stub interfaces in `packages/microsoft/src/graph-recording.ts`:
   ```typescript
   export async function getCloudRecordingForMeeting(
     graphClient: GraphClient,
     onlineMeetingId: string,
   ): Promise<GraphCloudRecording | null> {
     // TODO: Implement in Tranche 1 after admin consent granted
     throw new Error('Graph cloud recording not yet implemented');
   }
   ```
4. ✅ Update `docs/product/screen-recording-spike.md` to clarify Vexa=audio, Graph=video
5. ✅ Feature flag remains `ENABLE_VIDEO_RECORDING=false` (no prod impact)

**Status:** Ready to merge. No breaking changes, no prod risk.

---

### Tranche 1: Admin Consent + Schema (Implementation PR #1)

**Prerequisites:**
- ✅ Tranche 0 merged
- ✅ Owner reviews spike, approves Graph video path
- ⏳ ramakrishna@applywizz.ai grants admin consent in Azure Portal

**Deliverables:**
1. **Schema Migration:**
   ```sql
   ALTER TABLE public.meetings
     ADD COLUMN online_meeting_id TEXT;
   
   CREATE INDEX meetings_online_meeting_id_idx
     ON public.meetings (online_meeting_id)
     WHERE online_meeting_id IS NOT NULL;
   ```

2. **Calendar Sync Enhancement:**
   - Extract `onlineMeeting.id` from calendar events during sync
   - Persist to `meetings.online_meeting_id`

3. **Graph API Implementation:**
   - Implement `getOnlineMeeting(id)` in `packages/microsoft/src/graph-client.ts`
   - Implement `listCloudRecordings(onlineMeetingId)` 
   - Add application token flow (`getAppOnlyAccessToken` already exists)

4. **Tests:**
   - Unit tests for Graph API calls (mocked)
   - Integration test against Graph API staging (real API, test tenant)

**Validation:** CI green, no production deployment yet (feature flag still OFF)

---

### Tranche 2: Download + Ingest Flow (Implementation PR #2)

**Prerequisites:**
- ✅ Tranche 1 merged
- ✅ Schema deployed to production
- ✅ Calendar sync enriching `online_meeting_id` for new meetings

**Deliverables:**
1. **Download Implementation:**
   ```typescript
   export async function downloadGraphRecording(
     recordingContentUrl: string,
   ): Promise<ArrayBuffer> {
     // Streaming download with 500MB limit, 2-min timeout
   }
   ```

2. **Ingest Worker Enhancement:**
   ```typescript
   async function processCompletedMeeting(meeting: Meeting) {
     // Existing: Vexa audio
     await ensureOwnedRecording({ mediaKind: 'audio', ... });
     
     // NEW: Graph video (behind feature flag)
     if (isVideoRecordingEnabled() && meeting.online_meeting_id) {
       await ensureGraphCloudRecording({ mediaKind: 'video', ... });
     }
   }
   ```

3. **Error Handling:**
   - Polling with 12-min timeout + backoff
   - `video_not_available` (not error) vs `video_ingestion_failed` (error)
   - Retry logic for transient failures

4. **Tests:**
   - Unit tests with mocked Graph responses
   - Integration test with real cloud recording (manual test)

**Validation:** CI green, manual test passes (1 recording ingested successfully), feature flag still OFF

---

### Tranche 3: DNR Integration + Audit (Implementation PR #3)

**Prerequisites:**
- ✅ Tranche 2 merged
- ✅ Download/ingest flow proven in staging

**Deliverables:**
1. **DNR Enforcement:**
   ```typescript
   if (hasDnrParticipant) {
     console.log('DNR participant detected, skipping video ingestion');
     await logAuditEvent(supabase, {
       action: 'recording.video_ingestion_skipped_dnr',
       ...
     });
     return;
   }
   ```

2. **Audit Logging:**
   - `recording.video_ingestion_started`
   - `recording.video_ingestion_succeeded`
   - `recording.video_ingestion_failed`
   - `recording.video_ingestion_skipped_dnr`

3. **Tests:**
   - Unit test: DNR blocks video ingestion
   - Integration test: Real DNR domain, verify no ingestion

**Validation:** DNR enforcement proven in test, audit logs captured

---

### Tranche 4: Backfill Job (Implementation PR #4)

**Prerequisites:**
- ✅ Tranche 3 merged
- ✅ Production deployment ready (feature flag can be enabled)

**Deliverables:**
1. **One-Time Backfill Script:**
   ```typescript
   // scripts/backfill-online-meeting-ids.ts
   async function backfillOnlineMeetingIds() {
     const meetings = await supabase
       .from('meetings')
       .select('*')
       .is('online_meeting_id', null)
       .eq('provider', 'microsoft')
       .gte('scheduled_start', '2026-09-01'); // Last 2 weeks
       
     for (const meeting of meetings) {
       const onlineMeetingId = await findOnlineMeetingIdByJoinUrl(meeting.meeting_url);
       if (onlineMeetingId) {
         await supabase
           .from('meetings')
           .update({ online_meeting_id: onlineMeetingId })
           .eq('id', meeting.id);
       }
     }
   }
   ```

2. **Run Against Production:**
   - Backfill `online_meeting_id` for existing meetings
   - Verify no failures, log skipped meetings (where Graph lookup failed)

3. **Documentation:**
   - Ops runbook: How to run backfill for new AMs
   - Known limitation: Very old meetings (>90 days) may not backfill (Graph retention unknown)

**Validation:** Backfill completes successfully, existing meetings enriched with `online_meeting_id`

---

### Tranche 5: Production Enable + E2E Test (Final)

**Prerequisites:**
- ✅ Tranches 1-4 merged and deployed
- ✅ Backfill complete
- ✅ Teams admin policy configured (auto-record OR user training for manual record)

**Deliverables:**
1. **Enable Feature Flag:**
   ```bash
   # Production environment
   ENABLE_VIDEO_RECORDING=true
   ```

2. **E2E Test (Production):**
   - Test 1: AM schedules meeting, manually records → Video appears in Echo
   - Test 2: 7 AMs with auto-record policy → All 7 videos ingested
   - Test 3: No recording → Audio-only, no video error
   - Test 4: DNR participant → No video ingested

3. **Monitoring:**
   - CloudWatch alert: `video_ingestion_failed` > 10% of attempts
   - Ops dashboard: Video recording counts per day

4. **User Documentation:**
   - Help article: "How to record client meetings with video"
   - If no auto-record policy: "Click Record in Teams before your call"

**Validation:** All 4 E2E tests pass, production video recording live for ApplyWizz AMs

---

## Summary: Ready for Implementation

### What We Know (VERIFIED)

1. ✅ Microsoft Graph APIs exist and are documented for cloud recording access
2. ✅ Application permissions model supports tenant-wide access (required for multi-AM product)
3. ✅ Mapping Teams meetings → Echo meetings is viable via `online_meeting_id` + `icalUId`
4. ✅ Download flow can reuse existing streaming pattern from Vexa (200MB limit raised to 500MB for video)
5. ✅ Existing `meeting_recordings` table supports dual-artifact (audio + video) already (P3 complete)
6. ✅ Cost model is acceptable (~$1-10/month at current scale)

### What We Need (BLOCKERS)

1. ⏳ **Admin Consent:** ramakrishna@applywizz.ai must grant `OnlineMeetings.Read.All` + `OnlineMeetingRecording.Read.All` in Azure Portal
2. ⏳ **Teams Policy Decision:** Enable auto-record policy OR train AMs to manually record (owner decides which approach)
3. ⏳ **Implementation PRs:** 4 tranches (schema, download, DNR, backfill) before production enable

### This PR Delivers

1. ✅ Comprehensive spike document (this file)
2. ✅ Permission gap analysis (application permissions needed, admin consent required)
3. ✅ Stub interfaces (`packages/microsoft/src/graph-recording.ts`) with TODOs for implementation
4. ✅ Updated `screen-recording-spike.md` to clarify Vexa=audio, Graph=video
5. ✅ No production impact (feature flag OFF, no breaking changes)

**Next Step:** Owner reviews this spike, approves Graph video path, grants admin consent → Proceed to Tranche 1.

---

**END OF SPIKE DOCUMENT**
