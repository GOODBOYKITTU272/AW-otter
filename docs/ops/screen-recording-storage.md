# Screen Recording Storage & Retention (P3)

**Status:** PENDING OWNER DECISION  
**Feature:** Video recording E2E (dual-artifact audio + video)  
**Migration:** `20260912240001_p3_screen_recording_media_kind.sql`

## Current State

### Storage Limits

- **Bucket:** `meeting-recordings` (Supabase Storage)
- **Size limit:** 5 GiB per file (raised from 50 MiB)
- **Rationale:**
  - 1080p screen recording: ~100-300 MB/hour at moderate quality
  - Typical meeting: 30-60 minutes → 50-300 MB
  - 5 GiB provides 10-50x headroom for long/high-quality sessions
  - Still bounded for cost/abuse protection

### Schema

- **Table:** `meeting_recordings`
- **Uniqueness:** `UNIQUE(organization_id, meeting_id, media_kind)`
- **media_kind:** `'audio'` | `'video'`
- **Immutability:** Once stored, recordings CANNOT be overwritten or deleted by application code

### Current Sizing

| Artifact | Typical Size | Max per File | Est. per Month* |
|----------|-------------|--------------|-----------------|
| Audio    | 2-10 MB     | 50 MiB (old) | ~500 MB        |
| Video    | 50-300 MB   | 5 GiB (new)  | ~15-90 GB      |

\* Assumes 50 meetings/month, 45-minute average, moderate video quality

## Retention Policy

### Current Behavior

**NO AUTOMATIC DELETION** — P3 deliberately does not implement retention:

- Recordings are immutable (cannot be overwritten)
- No user-facing delete feature
- No worker job for automatic cleanup
- No TTL or expiration logic

This is NOT "store forever" as a designed guarantee — it is "we do not build deletion in P3."

### Owner Decision Required

Before enabling video recording in production (`ENABLE_VIDEO_RECORDING=true`):

1. **Retention duration** — how long to keep recordings?
   - Options: 30 days, 90 days, 1 year, indefinite
   - Consider: compliance, cost, customer expectations

2. **Deletion mechanism** — manual or automatic?
   - Manual: Admin UI for per-recording deletion
   - Automatic: Worker job with configurable retention window
   - Hybrid: Automatic + override for "pin this meeting"

3. **Cost projection** — video storage is 10-30x larger than audio
   - Estimate: \[org count\] × \[meetings/month\] × \[avg video size\] × \[retention months\]
   - Example: 10 orgs × 50 meetings × 150 MB × 3 months = **225 GB** → ~$5-10/month Supabase Storage

4. **Compliance** — do customers have data residency or deletion requirements?
   - GDPR right to erasure: requires per-user meeting deletion
   - Industry regulations: healthcare/finance may mandate retention minimums OR maximums

## Monitoring

### Key Metrics (NOT YET IMPLEMENTED)

P3 does NOT create fake metrics in Admin UI. Real implementation deferred to follow-up milestone.

When implemented, track:

- **Total storage used** per organization (audio + video separately)
- **Average file sizes** (detect anomalous large uploads)
- **Ingest failure rate** for video (high rate → investigate Vexa video availability)
- **Bucket capacity utilization** (approaching 5 GiB limit per file)

### Lifecycle Events (ALREADY LOGGED)

These events are already logged by P3 transcription worker:

- `recording.video_ingested` — video successfully stored
- `recording.video_not_available` — Vexa had no video artifact (expected when feature off or audio-only meeting)
- `recording.video_ingestion_failed` — real failure (network, storage, etc.) — investigate

Query: `meeting_lifecycle_events` table, filter `event_type` like `'recording.video%'`

## Runbook: Investigate High Storage Usage

### Symptom

Storage costs increase significantly after enabling video recording.

### Investigation

1. **Check lifecycle events for video ingestion rate:**

```sql
SELECT 
  event_type,
  COUNT(*) as count,
  DATE_TRUNC('day', occurred_at) as day
FROM meeting_lifecycle_events
WHERE event_type LIKE 'recording.video%'
  AND occurred_at > NOW() - INTERVAL '7 days'
GROUP BY event_type, day
ORDER BY day DESC, event_type;
```

Expected: `video_not_available` >> `video_ingested` when feature flag OFF

2. **Check average file sizes:**

```sql
SELECT 
  media_kind,
  COUNT(*) as count,
  AVG(byte_size) / 1024 / 1024 as avg_mb,
  MAX(byte_size) / 1024 / 1024 as max_mb,
  SUM(byte_size) / 1024 / 1024 / 1024 as total_gb
FROM meeting_recordings
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY media_kind;
```

Expected: audio ~5-10 MB avg, video ~100-300 MB avg

3. **Identify largest recordings:**

```sql
SELECT 
  mr.id,
  mr.media_kind,
  mr.byte_size / 1024 / 1024 as size_mb,
  m.title,
  m.scheduled_start,
  mr.created_at
FROM meeting_recordings mr
JOIN meetings m ON m.id = mr.meeting_id
WHERE mr.media_kind = 'video'
ORDER BY mr.byte_size DESC
LIMIT 10;
```

Anomalies: video files >2 GB suggest very long meetings or quality misconfiguration

### Remediation

- **Short-term:** Manually delete outlier recordings via SQL (service-role client)
- **Long-term:** Implement retention policy worker (automatic cleanup)

## Runbook: Implement Retention Policy

### Prerequisites

Owner has decided:
- Retention duration (e.g., 90 days)
- Deletion mechanism (automatic vs manual)

### Steps

1. **Create retention policy configuration:**

```sql
-- Option A: Global retention (all orgs same policy)
ALTER TABLE meeting_recordings
ADD COLUMN delete_after TIMESTAMPTZ;

-- Option B: Per-org retention (flexible)
ALTER TABLE meeting_policy_sets
ADD COLUMN recording_retention_days INT DEFAULT 90;
```

2. **Create deletion worker:**

```typescript
// packages/domain/src/recording-retention.ts
export async function deleteExpiredRecordings(
  serviceRoleClient: AppSupabaseClient,
  storage: RecordingStorageClient,
): Promise<{ deleted: number }> {
  // Query recordings older than retention window
  // Delete from Storage bucket first, then DB row
  // Log lifecycle event for audit trail
}
```

3. **Schedule worker:**

Add cron job or worker queue entry to run `deleteExpiredRecordings` daily.

4. **Test thoroughly:**

- Verify recordings are actually deleted from Storage (not just DB)
- Verify transcripts remain intact (they reference recording ID but don't break when recording is gone)
- Verify lifecycle events are logged for every deletion

## Security Notes

- **Storage bucket is PRIVATE** (no public access)
- **Signed URLs expire in 10 minutes** (no permanent public links)
- **RLS enforces meeting visibility** (requester must have meeting access)
- **Service-role client bypasses RLS** (workers use this for ingestion/deletion)
- **No user-facing delete UI** in P3 (prevents accidental data loss)

## Related Documentation

- **Spike investigation:** `docs/product/screen-recording-spike.md`
- **Original design:** `docs/superpowers/specs/2026-09-10-recording-ownership-design.md`
- **Migration:** `supabase/migrations/20260912240001_p3_screen_recording_media_kind.sql`
- **Ingest logic:** `packages/domain/src/transcription.ts` (video best-effort after audio)
- **Feature flags:** `packages/domain/src/feature-flags.ts`
