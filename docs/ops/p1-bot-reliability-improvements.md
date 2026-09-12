# Phase-1 Bot Reliability Improvements

This document summarizes Phase-1 reliability enhancements for Apply Wizz Echo bot deployment, covering auto-join/lobby detection and auto-leave/recording finalization.

## Summary

**Status**: ✅ **Implemented** (Branch: `cursor/p3-bot-auto-leave-finalize-b07e`)

Phase-1 addresses two critical reliability gaps:

1. **Auto-join / Lobby Detection**: Detect and alert when bots are stuck in Teams lobby
2. **Auto-leave / Recording Finalization**: Automatically stop bots and finalize recordings when meetings end

---

## 1. Auto-join / Lobby Admission

### What We Implemented

✅ **Lobby detection and alerting** (Already on `p3-production-readiness`):
- Database tracking: `meeting_bot_jobs.lobby_waiting_since` and `last_raw_status`
- Live alert system: Detects bots waiting in lobby > 75 seconds
- UI visibility: Admin meetings page shows "⚠️ Waiting in lobby" status
- Operational incidents: Alerts logged for AM/Manager visibility

### What We CANNOT Fix in Software

❌ **Automatic lobby bypass**: Microsoft Teams enforces lobby admission based on the **host organization's tenant policy**, not our code. Vexa bots join as anonymous guests without a trusted Microsoft identity, so they land in the lobby by default.

**Two deployment scenarios**:

1. **ApplyWizz-hosted meetings**: ApplyWizz IT can configure our own Microsoft 365 tenant policy to auto-admit bots or reduce lobby friction for meetings we organize.
   
2. **Customer-hosted meetings**: ApplyWizz has **no control** over customer tenant policies. The bot will land in the lobby and require the meeting organizer (the customer or AM) to manually admit it.

### Operational Guidance

**For ApplyWizz-hosted meetings**:
- Work with ApplyWizz IT to configure tenant meeting policies:
  - "Who can bypass the lobby" → Consider allowing external participants for scheduled meetings
  - "Automatically admit people" → Enable for organizational meetings
  
**For customer-hosted meetings**:
- **Expectation**: Bot will land in lobby, requiring manual admission
- **AM onboarding**: Brief AMs that they'll need to click "Admit" when Echo joins
- **Detection**: System alerts AMs/Managers when bot is waiting > 75 seconds
- **Not a bug**: This is standard Teams behavior for anonymous participants

### Reference Documentation

- `docs/ops/teams-bot-admission-policy.md` - Detailed policy investigation
- `docs/ops/p0-lobby-detection/INVESTIGATION.md` - Technical deep-dive
- `docs/ops/p0-lobby-detection/E2E-TEST-PLAN.md` - Testing scenarios

---

## 2. Auto-leave / Recording Finalization

### Problem Statement

**Observed behavior** (before Phase-1 P1):
- Vexa bot stayed `active` after meeting ended
- Recording remained `in_progress` indefinitely
- Transcription pipeline could not proceed until manual DELETE /bots/{id} call
- Ops team had to manually stop bots to finalize recordings

**Root cause**: Vexa does not automatically stop bots when meetings end. Our system relied on Vexa removing bots from the `/bots/status` running list, which did not happen reliably for ended meetings.

### What We Implemented

✅ **Proactive bot auto-leave detection** (`detectAndStopEndedMeetingBots`):

Stops a bot when **ANY** of these conditions are met:

1. **Meeting definitively ended**: `meetings.actual_end` is set
2. **Scheduled end + grace period passed**: `scheduled_end + 15 minutes` has elapsed AND no active attendees remain
3. **No-show scenario**: Bot has been joined alone (no human attendees) for 10+ minutes

**When a bot is stopped**:
- Calls `provider.cancelBot()` to trigger Vexa to finalize recording
- Marks bot status as `completed` with `left_at` timestamp
- Logs `bot.auto_leave` lifecycle event with reason
- Allows transcription pipeline to proceed

**Hardened status transitions**:
- `syncBotStatuses` now always sets `left_at` when transitioning to `completed`
- Ensures recording finalization can proceed even if Vexa doesn't report `end_time`

### Thresholds

```typescript
GRACE_AFTER_SCHEDULED_END_MS = 15 * 60 * 1000  // 15 minutes
EMPTY_CALL_DURATION_MS = 10 * 60 * 1000        // 10 minutes
```

**Rationale**:
- 15-minute grace period covers late joins, meeting overruns
- 10-minute empty-call threshold balances no-show detection vs. patience for customer arrival
- Conservative values minimize false positives (stopping too early)

### Integration

Auto-leave detection runs on every `/api/internal/meeting-bots/tick` call:

```typescript
// apps/web/app/api/internal/meeting-bots/tick/route.ts
const autoLeaveResult = await detectAndStopEndedMeetingBots(
  serviceRoleClient,
  provider,
);
```

Typically called every 1-5 minutes by orchestrator worker.

### Testing

32 tests added to `packages/domain/src/meeting-bots.test.ts`:
- ✅ Stops bot when `actual_end` is set
- ✅ Stops bot after scheduled end + grace period with no attendees
- ✅ Stops bot after 10+ minutes alone (no-show)
- ✅ Does NOT stop bot when meeting is ongoing with active attendees
- ✅ Does NOT stop bot below no-show threshold (5 minutes)
- ✅ Continues processing if one `cancelBot` call fails

**Run tests**:
```bash
cd /workspace/packages/domain
npm test -- src/meeting-bots.test.ts
```

---

## Impact

### Before Phase-1 P1

**Lobby waiting**: Silent failure, no visibility, manual investigation required  
**Auto-leave**: Manual intervention required to stop bots and finalize recordings  
**Recording finalization**: Blocked until ops team noticed and stopped bot  
**Transcription pipeline**: Could not proceed until manual stop  

### After Phase-1 P1

**Lobby waiting**: Detected within 75 seconds, alerts sent to AM/Manager, UI shows clear "Admit bot" instruction  
**Auto-leave**: Automatic detection and stop within 1 tick cycle (~1-5 min after condition met)  
**Recording finalization**: Automatic via `cancelBot()` call  
**Transcription pipeline**: Proceeds automatically after bot stop  

---

## Monitoring & Alerts

### Lifecycle Events

New event types logged to `meeting_lifecycle_events`:
- `bot.auto_leave` - Bot stopped due to meeting end detection (includes reason in payload)
- `bot.auto_leave_failed` - `cancelBot()` call failed (logs error, continues to next bot)

### Operational Incidents

Lobby alerts continue to be logged via `operational_incidents` table:
- Queue: `live_alerts`
- Incident type: `bot_lobby_stuck`
- Visible in AM Home and Manager overview pages

### Metrics

Track in dashboards/queries:
- Auto-leave success rate: `bot.auto_leave` events / active bots
- Auto-leave reasons: Parse payload for reason distribution (actual_end vs. grace_period vs. no-show)
- Failed cancellations: Count `bot.auto_leave_failed` events

---

## Future Improvements (Out of Scope for Phase-1)

### Not Implemented

- ❌ Native Teams bot registration (requires different integration, can't control customer tenants)
- ❌ Automatic retry/re-admit for lobby (no platform support)
- ❌ Real-time participant tracking (relies on Graph webhooks or post-meeting sync)
- ❌ Dynamic threshold tuning (conservative fixed thresholds for V1)

### Possible Enhancements

1. **Graph API integration for participant events**: Subscribe to Microsoft Graph meeting participant webhooks to detect host/attendee leave in real-time (requires `OnlineMeetings.Read.All` permission)
   
2. **Per-organization threshold configuration**: Allow orgs to customize grace period and no-show thresholds via `meeting_policy_sets`
   
3. **Smarter no-show detection**: Check `meeting_attendees.invited` count vs. `attended` to distinguish "no invitees" from "customer didn't show"
   
4. **ApplyWizz tenant policy automation**: Script tenant policy configuration for AW-hosted meetings (IT task, not code)

---

## Deployment Checklist

When deploying to production:

1. ✅ Run database migrations (already on `p3-production-readiness`):
   - `20260912230001_bot_lobby_detection.sql` (lobby tracking fields)

2. ✅ Deploy application code:
   - `packages/domain/src/meeting-bots.ts` (auto-leave logic)
   - `apps/web/app/api/internal/meeting-bots/tick/route.ts` (integration)

3. ✅ Verify tests pass:
   ```bash
   cd /workspace/packages/domain
   npm test -- src/meeting-bots.test.ts
   ```

4. 📊 Monitor lifecycle events for 24-48 hours:
   - Check for `bot.auto_leave` events
   - Verify no unexpected `bot.auto_leave_failed` spikes
   - Confirm transcription pipeline proceeds after bot stop

5. 📋 Ops team awareness:
   - Lobby admission remains manual for customer-hosted meetings (expected, not a bug)
   - Auto-leave should reduce manual bot stops to zero
   - Alert on `bot.auto_leave_failed` events

---

## References

- **Lobby detection**: `docs/ops/p0-lobby-detection/` directory
- **Teams policy**: `docs/ops/teams-bot-admission-policy.md`
- **Bot tables**: `supabase/migrations/20260907030001_meeting_bot_tables.sql`
- **Lobby migration**: `supabase/migrations/20260912230001_bot_lobby_detection.sql`
- **Code**: `packages/domain/src/meeting-bots.ts` (lines 518-683)
- **Tests**: `packages/domain/src/meeting-bots.test.ts` (lines 1103-1450)

---

**Document version**: 1.0  
**Last updated**: 2026-09-12  
**Branch**: `cursor/p3-bot-auto-leave-finalize-b07e`  
**Author**: Cloud Agent (Phase-1 P1 implementation)
