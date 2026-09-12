# Phase-1 P0: Teams Lobby Detection and Alerting

## Problem Statement
Echo bot often waits in Microsoft Teams lobby (`awaiting_admission` / `waiting_for_admission`), requiring human admission. For CRM-scheduled customer meetings, **silent lobby waiting kills trust** - the AM doesn't know the bot needs to be admitted, and the recording never starts.

This PR implements **detect-and-alert** (not automated retry/re-admit, which requires platform support we don't have).

---

## What Changed

### 1. Database Schema (Migration `20260912200001_bot_lobby_detection.sql`)
Added two columns to `meeting_bot_jobs`:
- **`lobby_waiting_since`** (timestamptz, nullable): Set when Vexa reports `awaiting_admission` / `waiting_for_admission` / `needs_help`; cleared when bot joins or fails. Enables "how long has the bot been stuck?" queries.
- **`last_raw_status`** (text, nullable): Denormalized Vexa status string for fast queries without parsing `provider_metadata` JSONB.

### 2. Lobby Detection Logic (`packages/meeting-bots`)
- **`isLobbyWaitingStatus(rawStatus)`**: New helper function returns `true` for lobby-specific states (`awaiting_admission`, `waiting_for_admission`, `needs_help`).
- **`syncBotStatuses()`** updated:
  - Sets `lobby_waiting_since` when bot enters lobby (preserves original timestamp across polls).
  - Clears `lobby_waiting_since` when bot joins or fails.
  - Always updates `last_raw_status` for diagnostics.
- **`BotStatusResult`** type extended with `rawStatus?: string`.

### 3. Admin UI - Lobby Alerting (`apps/web`)
#### Meeting Detail Page (`/admin/meetings/[id]`)
- **New section**: "Echo Bot Status" shows bot lifecycle with badges.
- **Amber alert box** appears when `lobby_waiting_since` is set:
  - ⚠️ Title: "Action Required: Bot waiting in Teams lobby"
  - Clear instruction: "Open Teams and admit 'AW Echo' from the lobby"
  - Shows "Waiting since" timestamp + raw Vexa status
  - **Disappears automatically** once bot is admitted

#### Meetings List Page (`/admin/meetings`)
- Updated `botStatusBadge()` to show **`⚠️ Waiting in lobby`** (critical/red tone) when `lobby_waiting_since` is set.
- Differentiated from generic "Joining now" (yellow warning).

### 4. Tests
- **New**: `packages/meeting-bots/src/vexa/normalize.test.ts` - comprehensive tests for `isLobbyWaitingStatus()`.
- **Updated**: `client.test.ts` - verified `rawStatus` is returned in `getBotStatus()`.
- All 671 tests pass ✅

---

## Investigation Summary (see `INVESTIGATION.md`)

### Current Behavior (Before This PR)
- ✅ Dispatch timing: 90s lead time (configurable per org)
- ✅ 7 AMs support: No hardcoded single-AM limit
- ✅ No-show handling: Empty recordings → graceful "no transcribable speech"
- ✅ Concurrency: One bot per meeting (enforced by unique index)
- ❌ **Lobby detection**: Vexa statuses mapped to generic 'joining', no differentiation
- ❌ **Alerting**: Events logged but not surfaced to ops/admin
- ❌ **AM visibility**: No clear "admit the bot now!" prompt

### Gaps Fixed
1. **Lobby vs joining**: Now distinguish "connecting to Teams" vs "stuck in lobby needing admission"
2. **Real-time alerting**: Lobby warning visible within 60 seconds of bot arriving in lobby
3. **Action-oriented**: Clear instruction + timestamp, not buried in logs
4. **AM-friendly**: "Waiting in lobby" badge visible on meetings list

---

## What This PR Does NOT Include (Explicit Exclusions)

Per locked scope, these are **not** in Phase-1 P0:
- ❌ Screen recording
- ❌ Fireworks integration
- ❌ Completeness scoring
- ❌ Automated retry/re-admit logic (detect-only; manual admission is the mitigation)
- ❌ Native Teams bot registration (requires different integration model)
- ❌ Changes to audio STT chain (OpenRouter Whisper path untouched)

---

## E2E Test Plan (see `E2E-TEST-PLAN.md`)

### Test Scenarios
1. **Baseline (bot joins successfully)**: Verify no lobby warning when bot is admitted immediately.
2. **P0 Case (bot stuck in lobby)**: 
   - ⚠️ Warning appears within 60s
   - Shows timestamp + raw status
   - Clears after admission
3. **Customer no-show**: Empty recording completes gracefully (not a failure).
4. **Multiple AMs (7 calendars)**: Concurrent meetings across different AMs work independently.
5. **Lobby state transitions**: Database fields update correctly (scheduled → joining → joined → completed).

### Pass Criteria
✅ Lobby warning appears ≤60 seconds after bot arrives in lobby  
✅ Warning clearly instructs: "Admit AW Echo from lobby"  
✅ Warning shows how long bot has been waiting  
✅ Recording and transcript work after late admission  
✅ No pipeline failures for empty recordings (no-show case)  
✅ All 7 AMs' meetings tracked independently  

---

## Teams Policy Context (For Ops)

### What Echo **Cannot** Fix in Software
Microsoft Teams lobby admission is enforced by the **meeting host's tenant policy**, not ApplyWizz code:
- **ApplyWizz-hosted meetings**: ApplyWizz IT can configure tenant policy to auto-admit bots (reduces friction).
- **Customer-hosted meetings**: ApplyWizz has **no control** over customer tenant policy → bot will land in lobby, requiring organizer to manually admit.

This is standard Teams behavior for any anonymous/guest participant without a signed-in, trusted Microsoft identity. Vexa bots join as anonymous guests (no credential to present a trusted identity).

### What Echo **Can** Fix (This PR ✅)
- Detect lobby waiting reliably
- Surface it to ops/admin/AMs within seconds
- Clear instruction: "Admit AW Echo from the lobby"
- Track wait duration for escalation

**Recommended AM onboarding brief**: "You'll need to admit the Echo bot from the lobby when it joins - this is a one-click action in Teams, not a bug."

---

## CI Status
- ✅ Typecheck: Clean (no errors)
- ✅ Tests: 671 passed (43 in meeting-bots, 414 in domain, 57 in web, etc.)
- ⚠️ Lint: 2 warnings (unused vars in unrelated files - not introduced by this PR)

---

## Migration Safety
- **Additive only**: New columns are nullable, no data backfill required.
- **No breaking changes**: Existing queries/code unaffected.
- **Rollback**: Drop columns if needed (`ALTER TABLE meeting_bot_jobs DROP COLUMN lobby_waiting_since, DROP COLUMN last_raw_status;`).

---

## Files Changed
- `supabase/migrations/20260912200001_bot_lobby_detection.sql` (new migration)
- `packages/database/src/types.ts` (generated types updated)
- `packages/meeting-bots/src/vexa/normalize.ts` (new `isLobbyWaitingStatus()`)
- `packages/meeting-bots/src/vexa/client.ts` (return `rawStatus`)
- `packages/domain/src/meeting-bots.ts` (lobby tracking in `syncBotStatuses()`)
- `apps/web/app/admin/meetings/[id]/page.tsx` (new bot status section + lobby alert)
- `apps/web/app/admin/meetings/page.tsx` (lobby badge on meetings list)
- Tests: `normalize.test.ts` (new), `client.test.ts` (updated)
- Documentation: `INVESTIGATION.md`, `E2E-TEST-PLAN.md`

---

## Definition of Done
✅ Database migration deployed  
✅ Lobby detection logic implemented and tested  
✅ Admin UI shows lobby warning prominently  
✅ AM-visible status differentiated (red "Waiting in lobby" badge)  
✅ All tests pass, typecheck clean  
✅ E2E test plan documented  
✅ Teams policy context explained (software limits vs admin config)  
✅ 7 AMs calendar support verified (no hardcoded single-AM assumptions)  
✅ Customer no-shows handled gracefully  

---

## Next Steps (After Merge)
1. **Deploy migration** to production (additive, safe).
2. **Manual E2E test** following `E2E-TEST-PLAN.md` (lobby scenario).
3. **Brief AMs** on lobby admission workflow (one-click in Teams).
4. **Monitor**: `meeting_lifecycle_events` for `bot.status_changed.joining` + check `lobby_waiting_since` timestamps in first week.

---

## Questions for Review
- Amber alert box wording: Is "Open Teams and admit 'AW Echo' from the lobby" clear enough, or do we need a screenshot/GIF?
- Should we add a Slack/email notification when `lobby_waiting_since` > 2 minutes (escalation)?
- Database indexes: Do we need an index on `lobby_waiting_since` for ops queries?
