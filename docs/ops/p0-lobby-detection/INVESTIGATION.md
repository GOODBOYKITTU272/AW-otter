# Investigation: Current Vexa Bot Join Behavior

## Dispatch Timing (~90s lead time)
- **Configured via**: `meeting_policy_sets.bot_dispatch_lead_seconds` (DB-level default: 90 seconds)
- **Hardcoded fallback**: `DEFAULT_BOT_DISPATCH_LEAD_SECONDS = 90` in `packages/domain/src/meeting-bots.ts`
- **Implementation**: `processPendingBotJobs()` checks `dispatchAtMs = scheduled_start - leadSeconds * 1000` before dispatching
- **Late discovery protection**: 5-minute grace period after `scheduled_end` to avoid dispatching into completed meetings

## Lobby/Waiting States Detection

### Vexa API Status Mapping
Currently handled in `packages/meeting-bots/src/vexa/normalize.ts`:

```typescript
case "awaiting_admission":
case "waiting_for_admission":
case "needs_help":
  return "joining";
```

**Current behavior**: Lobby states (`awaiting_admission`, `waiting_for_admission`, `needs_help`) are **already mapped to our 'joining' status** but:
- ❌ No differentiation between "joining" (network/Teams connecting) vs "waiting in lobby" (needs human admit)
- ❌ No admin/ops alerting when bot is stuck in lobby
- ❌ AM-visible UI shows generic "Joining now" without urgency indicator

### Database Fields
`meeting_bot_jobs` table has:
- `status` enum: pending | scheduled | joining | joined | completed | cancelled | failed
- `scheduled_at`, `joined_at`, `left_at`, `cancelled_at`, `failed_at` timestamps
- `provider_metadata` (JSONB) - stores raw Vexa response with full status details
- `last_error` text field

## Status Polling & Updates
- **Worker**: `apps/web/app/api/internal/meeting-bots/tick/route.ts` calls `syncBotStatuses()` 
- **Frequency**: Worker polls (likely every 1-5 minutes based on typical cron patterns)
- **Implementation**: `syncBotStatuses()` in `packages/domain/src/meeting-bots.ts`
  - Queries jobs with status in `['scheduled', 'joining', 'joined']`
  - Calls `provider.getBotStatus()` for each
  - Updates status if changed, with 2-minute grace period for new 'scheduled' bots

## Lifecycle Events (Alerts System)
`meeting_lifecycle_events` table logs:
- `bot_intent.created`, `bot.scheduled`, `bot.status_changed.{status}`, `bot.schedule_failed`, etc.
- **Admin-only visibility** - not currently surfaced to AMs
- Events stored but no active alerting mechanism

## Meeting AI / AM Coverage
**7 AMs calendar support**:
- ✅ No hardcoded single-AM assumption found
- ✅ Microsoft Graph integration (`packages/microsoft`) handles multi-user calendars
- ✅ `meetings.owner_membership_id` properly tracks which AM owns each meeting
- ✅ Bot dispatching works per-meeting, not per-AM
- ⚠️ **Concurrency**: One bot per meeting enforced by unique index `meeting_bot_jobs_one_live_per_meeting_uq`
- ⚠️ **Worker capacity**: No explicit concurrency limits in code, but Vexa API may have rate limits (429 handling exists)

## Current UI Status Display

### Admin Meetings List (`/admin/meetings`)
Shows bot status with labels:
- "Preparing" (pending)
- "Ready to join" (scheduled)
- **"Joining now"** (joining) - ⚠️ No distinction for lobby waiting
- "Recording" (joined)
- "Recorded" (completed)
- "Failed to join" (failed)

### Meeting Detail Page (`/admin/meetings/[id]`)
- Shows transcript status
- **Does NOT show bot job status** - ❌ Missing
- Shows lifecycle events in technical log (if implemented)

## Customer No-Show Handling
**Current behavior**:
- Bot waits in meeting regardless of attendee presence
- No explicit "no-show" detection - bot joins, records silence, completes normally
- Empty transcript (0 segments) handled gracefully: "This meeting had no transcribable speech"
- No hard pipeline failure for empty recordings ✅

## Summary of Gaps (What This PR Fixes)

1. **Lobby detection**: 'joining' status exists but not differentiated from lobby-waiting
2. **Alerting**: Events logged but not surfaced to ops/admin in real-time
3. **AM visibility**: No clear "Admit the bot now!" messaging
4. **Status granularity**: Need to distinguish "connecting" vs "waiting for admission"
5. **Meeting detail page**: Bot status not shown at all

## What Does NOT Need Fixing
- ✅ Dispatch timing (90s lead works)
- ✅ 7 AMs support (no hardcoded limits)
- ✅ No-show handling (graceful already)
- ✅ Concurrency model (one bot per meeting is correct)
- ✅ Rate limit handling (429 retry exists)
- ✅ Audio STT chain (OpenRouter Whisper, not Vexa - no changes)
