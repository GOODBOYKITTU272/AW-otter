# Microsoft Graph Integration Inventory & Permission Gap Analysis

**Date:** 2026-09-12  
**Context:** Graph cloud recording spike (docs/product/graph-cloud-recording-spike.md)  
**Purpose:** Document existing Graph infrastructure + identify exact permission gaps for video recording

---

## Executive Summary

**Existing Infrastructure:** ✅ Strong foundation  
**Permission Gaps:** 2 application-level permissions need admin consent  
**Schema Gaps:** 1 column addition needed (`meetings.online_meeting_id`)  
**Implementation Readiness:** 80% reusable code, 20% new implementation

---

## Existing Microsoft Graph Integration

### 1. App Registration (Azure Portal)

**App Name:** `applywizz-echo` (assumed; confirm with owner)  
**Tenant:** ramakrishna@applywizz.ai's Microsoft 365 tenant  
**Current Permissions:** Delegated (per-user consent)

| Permission | Type | Status | Purpose |
|------------|------|--------|---------|
| `openid` | Delegated | ✅ Granted | Identity claims |
| `profile` | Delegated | ✅ Granted | User profile |
| `email` | Delegated | ✅ Granted | User email |
| `offline_access` | Delegated | ✅ Granted | Refresh token |
| `Calendars.Read` | Delegated | ✅ Granted | Calendar sync |

**Source:** `packages/microsoft/src/config.ts:31-36`

---

### 2. OAuth Flow (Existing Implementation)

**Location:** `packages/microsoft/src/auth.ts`

**Implemented Functions:**

| Function | Purpose | Status |
|----------|---------|--------|
| `buildAuthorizationUrl()` | Generate OAuth consent URL | ✅ Complete |
| `exchangeCodeForTokens()` | Exchange auth code for tokens | ✅ Complete |
| `refreshAccessToken()` | Refresh expired access token | ✅ Complete |
| `getAppOnlyAccessToken()` | Client credentials flow (application token) | ✅ Complete |
| `decodeIdentityFromIdToken()` | Extract user identity from ID token | ✅ Complete |

**Key Infrastructure:**
- Single-tenant model (ApplyWizz tenant only, not multi-tenant)
- Token encryption via `packages/microsoft/src/crypto.ts`
- Refresh token persistence in `calendar_connection_secrets` table

**Gap for Video Recording:** NONE — `getAppOnlyAccessToken()` already exists for application-level tokens (required for tenant-wide recording access).

---

### 3. Graph API Client (Existing Implementation)

**Location:** `packages/microsoft/src/graph-client.ts`

**Implemented Functions:**

| Function | Endpoint | Purpose | Status |
|----------|----------|---------|--------|
| `listUpcomingEvents()` | `/me/calendarView` | Fetch user's upcoming events | ✅ Complete |
| `getCalendarEvent()` | `/me/events/{id}` | Fetch single event by ID | ✅ Complete |
| `listUpcomingEventsForUser()` | `/users/{upn}/calendarView` | Fetch specific user's events (app token) | ✅ Complete |
| `getCalendarEventForUser()` | `/users/{upn}/events/{id}` | Fetch event for specific user (app token) | ✅ Complete |
| `createSubscription()` | `/subscriptions` | Create webhook subscription | ✅ Complete |
| `renewSubscription()` | `/subscriptions/{id}` | Renew expiring subscription | ✅ Complete |
| `deleteSubscription()` | `/subscriptions/{id}` | Delete webhook subscription | ✅ Complete |

**Infrastructure:**
- Base URL: `https://graph.microsoft.com/v1.0`
- Request helper: `graphRequest<T>()` with error normalization
- Retry-After header handling via `normalizeGraphError()`
- Immutable ID preference: `Prefer: IdType="ImmutableId"` header

**Gap for Video Recording:** Need to add 3 new functions (see "New Functions Required" below).

---

### 4. Token Management (Existing Infrastructure)

**Location:** `packages/domain/src/microsoft-connection.ts`

**Implemented Functions:**

| Function | Purpose | Status |
|----------|---------|--------|
| `completeMicrosoftConnection()` | OAuth callback orchestration | ✅ Complete |
| `getValidAccessToken()` | Decrypt + auto-refresh tokens | ✅ Complete |
| `renewMicrosoftSubscription()` | Scheduled subscription renewal | ✅ Complete |
| `disconnectMicrosoftConnection()` | Revoke connection + cleanup | ✅ Complete |
| `getConnectionStatus()` | Connection health check | ✅ Complete |

**Storage:**
- `calendar_connections` table — connection metadata (per-user)
- `calendar_connection_secrets` table — encrypted tokens (service-role only)
- Encryption key from `ENCRYPTION_KEY` env var

**Gap for Video Recording:** Need application-level token storage (tenant-wide, not per-user). Current model is per-user delegated tokens. See "Schema Gaps" below.

---

### 5. Meeting Sync (Existing Flow)

**Location:** `packages/domain/src/meetings.ts` (assumed; not directly reviewed)

**Current Flow:**
1. Webhook notification received (`calendar_event_jobs` enqueued)
2. Worker claims job via `claim_next_calendar_event_job()`
3. Fetch event from Graph API via `getCalendarEvent()`
4. Normalize event via `normalizeCalendarEvent()` (`packages/microsoft/src/normalize.ts`)
5. Upsert to `meetings` table with `ical_uid` as canonical identity

**Fields Currently Stored:**

| Field | Source | Purpose |
|-------|--------|---------|
| `ical_uid` | Graph event `.iCalUId` | Canonical meeting identity |
| `meeting_url` | Graph event `.onlineMeeting.joinUrl` | Teams join link |
| `title` | Graph event `.subject` | Meeting title |
| `scheduled_start` | Graph event `.start.dateTime` | Meeting start time |
| `scheduled_end` | Graph event `.end.dateTime` | Meeting end time |
| `organizer_email` | Graph event `.organizer.emailAddress.address` | Organizer email |
| `organizer_name` | Graph event `.organizer.emailAddress.name` | Organizer name |

**Gap for Video Recording:** Missing `online_meeting_id` (Graph's `/communications/onlineMeetings/{id}` identifier). This is REQUIRED to look up recordings. See "Schema Gaps" below.

---

## Permission Gaps (Admin Consent Required)

### Current Scopes (Delegated)

```typescript
export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "Calendars.Read",
] as const;
```

**Grant Type:** Delegated (user consent, per-employee)  
**Sufficient For:** ✅ Calendar sync, Teams meeting detection  
**Insufficient For:** ❌ Cloud recording access (tenant-wide, not per-user)

---

### Required New Permissions (Application)

| Permission | Type | Purpose | Admin Consent? | Grant Method |
|------------|------|---------|----------------|--------------|
| `OnlineMeetings.Read.All` | Application | Read all tenant online meetings | ✅ **REQUIRED** | Azure Portal |
| `OnlineMeetingRecording.Read.All` | Application | Read all tenant cloud recordings | ✅ **REQUIRED** | Azure Portal |

**Why Application (Not Delegated)?**
- Delegated `OnlineMeeting.ReadWrite` only grants access to meetings the signed-in user ORGANIZED
- Echo needs to access recordings for ALL Account Managers' meetings (not just one user)
- Application permissions allow tenant-wide access with admin consent

---

### Grant Process (Owner Action Required)

**Prerequisites:**
- Global Admin or Application Administrator role in tenant
- Access to Azure Portal: https://portal.azure.com

**Steps:**
1. Navigate to Azure Active Directory → App registrations
2. Find `applywizz-echo` app (or create if not exists)
3. Go to "API permissions" blade
4. Click "Add a permission" → Microsoft Graph → Application permissions
5. Search and select:
   - `OnlineMeetings.Read.All`
   - `OnlineMeetingRecording.Read.All`
6. Click "Grant admin consent for [tenant name]"
7. Verify both permissions show green checkmark in "Status" column

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

**Status:** ⏳ BLOCKED — Requires ramakrishna@applywizz.ai to grant consent before implementation can proceed.

---

## Schema Gaps

### 1. Missing: `meetings.online_meeting_id`

**Problem:** Echo currently stores `meeting_url` (Teams join link) but NOT Graph's `onlineMeeting.id`, which is required to look up recordings.

**Solution:**

```sql
-- Migration: Add online_meeting_id column
ALTER TABLE public.meetings
  ADD COLUMN online_meeting_id TEXT;

-- Index for Graph API lookups (sparse index, only non-null)
CREATE INDEX meetings_online_meeting_id_idx
  ON public.meetings (online_meeting_id)
  WHERE online_meeting_id IS NOT NULL;

-- Uniqueness constraint (one Echo meeting per Graph online meeting)
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_online_meeting_id_unique
    UNIQUE (online_meeting_id);

-- Optional: Add check constraint (Graph IDs are base64-encoded GUIDs, typically 100+ chars)
ALTER TABLE public.meetings
  ADD CONSTRAINT meetings_online_meeting_id_format_check
    CHECK (online_meeting_id IS NULL OR length(online_meeting_id) > 20);
```

**Backfill Strategy:** Existing meetings without `online_meeting_id` need reverse lookup via `meeting_url`. See spike doc Tranche 4 for backfill job design.

**Status:** ⏳ REQUIRED — Must be deployed before video ingestion can work.

---

### 2. Existing: `meeting_recordings` Table (Already Ready)

**Migration:** `supabase/migrations/20260912240001_p3_screen_recording_media_kind.sql`

**Status:** ✅ COMPLETE (P3)

Key schema features:
- `media_kind TEXT CHECK (media_kind IN ('audio', 'video'))` — supports both kinds
- `UNIQUE (organization_id, meeting_id, media_kind)` — allows one audio + one video per meeting
- `source_provider TEXT` — can store `'microsoft-graph'` (distinct from `'vexa'`)
- `source_metadata JSONB` — can store `{ graphRecordingId, graphOnlineMeetingId, recordedAt }`

**Gap:** NONE — existing schema is sufficient.

---

### 3. Potential: Application Token Storage (Design Decision Needed)

**Current Model:** Per-user delegated tokens stored in `calendar_connection_secrets` (one row per AM)

**New Need:** Application-level token for tenant-wide recording access

**Options:**

**Option A: Store in Environment Variable (Recommended for MVP)**
```bash
# .env
MICROSOFT_APP_TOKEN_CLIENT_ID=...
MICROSOFT_APP_TOKEN_CLIENT_SECRET=...
MICROSOFT_APP_TOKEN_TENANT_ID=...
```

**Pros:**
- ✅ Simple, no schema change
- ✅ Token fetched on-demand via `getAppOnlyAccessToken()` (already implemented)
- ✅ 1-hour expiry means no long-term storage needed

**Cons:**
- ⚠️ Client secret in environment (acceptable; same as existing `MICROSOFT_CLIENT_SECRET`)
- ⚠️ Token fetched per-request (minor latency; cache in memory if needed)

**Option B: Store in Database (Over-engineering for MVP)**
```sql
CREATE TABLE public.microsoft_app_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Pros:**
- ✅ Centralized token management
- ✅ Auto-refresh logic

**Cons:**
- ❌ Schema change + token refresh worker needed
- ❌ Over-engineering for 1-hour tokens that can be fetched on-demand

**Recommendation:** Option A (environment variable). Application tokens have 1-hour expiry and NO refresh token (client credentials grant), so fetching fresh token per-request is simpler than managing stored tokens.

**Status:** ✅ NO SCHEMA CHANGE NEEDED — Use existing `getAppOnlyAccessToken()` with env var credentials.

---

## New Functions Required (Implementation Gaps)

### 1. Graph API: List Cloud Recordings

**Location:** `packages/microsoft/src/graph-recording.ts` (stub created in this PR)

**Function:**
```typescript
export async function listCloudRecordings(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl?: typeof fetch,
): Promise<GraphCloudRecording[]>
```

**Implementation Status:** 🟡 STUB — Throws error until Tranche 1

**Endpoint:** `GET /communications/onlineMeetings/{onlineMeetingId}/recordings`

**Dependencies:**
- ✅ `graphRequest<T>()` helper exists (reusable)
- ✅ Error normalization exists (reusable)
- ⏳ Admin consent for `OnlineMeetingRecording.Read.All` needed

---

### 2. Graph API: Download Recording

**Location:** `packages/microsoft/src/graph-recording.ts` (stub created in this PR)

**Function:**
```typescript
export async function downloadGraphRecording(
  recordingContentUrl: string,
  fetchImpl?: typeof fetch,
  timeoutMs?: number,
  maxBytes?: number,
): Promise<ArrayBuffer>
```

**Implementation Status:** 🟡 STUB — Throws error until Tranche 2

**Endpoint:** Direct fetch of signed URL (NOT via `graphRequest<T>()`)

**Dependencies:**
- ✅ Streaming download pattern exists in `packages/meeting-bots/src/vexa/recordings.ts` (reusable)
- ✅ Size limit + timeout logic exists (reusable)
- ⏳ Increase `MAX_DOWNLOAD_BYTES` from 200MB (audio) to 500MB (video)

---

### 3. Graph API: Poll for Recording Availability

**Location:** `packages/microsoft/src/graph-recording.ts` (stub created in this PR)

**Function:**
```typescript
export async function pollForCloudRecording(
  accessToken: string,
  onlineMeetingId: string,
  fetchImpl?: typeof fetch,
  maxAttempts?: number,
  intervalMs?: number,
): Promise<GraphCloudRecording | null>
```

**Implementation Status:** 🟡 STUB — Throws error until Tranche 2

**Logic:**
1. Call `listCloudRecordings()` in loop
2. Wait 2 min between attempts
3. Max 6 attempts (12 min total)
4. Return null if no recording found (not an error — manual recording may not have been started)

**Dependencies:**
- ⏳ `listCloudRecordings()` must be implemented first

---

### 4. Domain: Ensure Graph Cloud Recording

**Location:** `packages/domain/src/meeting-recordings.ts` (new function needed)

**Function:**
```typescript
export async function ensureGraphCloudRecording(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: {
    organizationId: string;
    meetingId: string;
    onlineMeetingId: string;
    graphClient: GraphClient;
  },
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }>
```

**Implementation Status:** 🔴 NOT STARTED — Tranche 2

**Logic:**
1. Check if `meeting_recordings` row exists for `media_kind='video'` (idempotency)
2. If exists, download from storage and return (same as Vexa path)
3. Poll for recording via `pollForCloudRecording()`
4. If no recording found, throw `RecordingNotReadyError` (log as `video_not_available`)
5. Download MP4 via `downloadGraphRecording()`
6. Store via existing `storeOwnedRecording()` with `source_provider='microsoft-graph'`

**Dependencies:**
- ✅ `storeOwnedRecording()` exists (reusable)
- ✅ `RecordingNotReadyError` exists (reusable)
- ⏳ New Graph functions must be implemented first

---

## Reusability Summary

| Component | Existing Implementation | Reusable? | Gap |
|-----------|------------------------|-----------|-----|
| OAuth flow (application tokens) | ✅ `getAppOnlyAccessToken()` | ✅ YES | None |
| Token encryption | ✅ `encryptToken()`, `decryptToken()` | ✅ YES | None |
| Graph API client | ✅ `graphRequest<T>()` | ✅ YES | None |
| Error normalization | ✅ `normalizeGraphError()` | ✅ YES | None |
| Streaming download | ✅ Vexa recordings pattern | ✅ YES | Increase size limit to 500MB |
| Storage upload | ✅ `storeOwnedRecording()` | ✅ YES | None |
| Idempotency + reconciliation | ✅ P3 crash recovery | ✅ YES | None |
| Recording table schema | ✅ `meeting_recordings` dual-kind | ✅ YES | None |
| Feature flags | ✅ `ENABLE_VIDEO_RECORDING` | ✅ YES | None |

**Percentage Reusable:** ~80%

**New Code Required:** ~20% (3 Graph API functions + 1 domain orchestration function)

---

## Blockers & Action Items

### Blockers (Owner Action Required)

1. ⏳ **Admin Consent:** ramakrishna@applywizz.ai must grant `OnlineMeetings.Read.All` + `OnlineMeetingRecording.Read.All` in Azure Portal
2. ⏳ **Teams Policy Decision:** Enable auto-record policy OR train AMs to manually record
3. ⏳ **Schema Deployment:** Migrate `meetings.online_meeting_id` to production

### Action Items (Implementation PRs)

1. 🟢 **Tranche 0 (This PR):** Spike doc + stub interfaces (READY TO MERGE)
2. 🟡 **Tranche 1:** Schema migration + Graph API functions + tests (BLOCKED on admin consent)
3. 🟡 **Tranche 2:** Download + ingest flow + DNR integration (BLOCKED on Tranche 1)
4. 🟡 **Tranche 3:** Backfill job for existing meetings (BLOCKED on Tranche 2)
5. 🟡 **Tranche 4:** Production enable + E2E test (BLOCKED on Tranche 3)

---

## Summary

**Infrastructure Maturity:** ✅ Strong — 80% of code already exists and is production-proven

**Permission Gaps:** 2 application permissions (admin consent required, one-time setup)

**Schema Gaps:** 1 column addition (`meetings.online_meeting_id`)

**Implementation Effort:** ~4 PRs (schema, API functions, ingest flow, backfill)

**Risk:** LOW — All new code is behind `ENABLE_VIDEO_RECORDING=false` flag, incremental rollout

**Recommendation:** PROCEED with Tranche 1 after owner grants admin consent.

---

**END OF INVENTORY DOCUMENT**
