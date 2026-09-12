# Phase-1 P0: Teams Lobby Detection - E2E Test Plan

## Prerequisites
- Access to ApplyWizz Signal admin account
- Microsoft Teams account with ability to create meetings
- At least one test customer/colleague to invite

## Test Scenario 1: Bot Joins Successfully (Baseline)

### Setup
1. Create a new Teams meeting scheduled 3 minutes from now
2. Invite yourself and one test participant
3. Configure meeting bot to record (ensure eligibility_status = 'record')

### Steps
1. Wait for bot dispatch (default: 90 seconds before meeting start)
2. Start the Teams meeting
3. **Admit the bot immediately** when it appears in lobby
4. Continue meeting for 2-3 minutes with some conversation
5. End the meeting

### Expected Behavior
- Admin meetings page shows bot status: "Ready to join" → "Joining now" → "Recording"
- Meeting detail page shows:
  - Bot Status section with green "Recording" badge
  - **No amber lobby warning** appears
  - Scheduled/Joined timestamps populate
- After meeting: Transcript processes successfully, no errors

### Pass Criteria
✅ Bot joins within 15 seconds of admission  
✅ No lobby warning displayed at any point  
✅ Transcript completes with spoken content  

---

## Test Scenario 2: Bot Stuck in Lobby (P0 Case)

### Setup
Same as Scenario 1

### Steps
1. Wait for bot dispatch (90 seconds before meeting start)
2. Start the Teams meeting
3. **Do NOT admit the bot** - leave it in lobby for 2-3 minutes
4. Check admin UI every 30 seconds
5. Eventually admit the bot
6. Continue meeting briefly, then end

### Expected Behavior (NEW - Phase-1 P0)
- Admin meetings page:
  - Bot status shows: "Ready to join" → **"⚠️ Waiting in lobby"** (critical/red badge)
- Meeting detail page:
  - **Amber warning box appears** prominently above bot details:
    - Title: "Action Required: Bot waiting in Teams lobby"
    - Message: "The Echo bot is waiting to be admitted to the meeting. Open Teams and admit 'AW Echo' from the lobby."
    - Shows "Waiting since" timestamp
    - Shows raw Vexa status in mono font (e.g., `awaiting_admission`)
- Database `meeting_bot_jobs` row:
  - `status` = 'joining'
  - `lobby_waiting_since` timestamp is set (not null)
  - `last_raw_status` = 'awaiting_admission' or 'waiting_for_admission'

After admission:
- Lobby warning disappears
- Status changes to "Recording"
- `lobby_waiting_since` cleared (null)

### Pass Criteria
✅ Lobby warning appears within 60 seconds of bot arriving in lobby  
✅ Warning clearly states "Action Required" and instructs to admit bot  
✅ Warning shows how long bot has been waiting  
✅ Warning disappears immediately after bot is admitted  
✅ Recording and transcript work normally after late admission  

---

## Test Scenario 3: Customer No-Show (Graceful Handling)

### Setup
- Schedule meeting with just yourself
- Ensure bot is configured to record

### Steps
1. Wait for bot dispatch
2. **Do NOT join the Teams meeting yourself**
3. Let the bot join alone (admit it if needed)
4. Wait 5 minutes
5. End/cancel the meeting

### Expected Behavior
- Bot joins successfully (or shows lobby warning if not admitted)
- Meeting completes with status = 'completed'
- Transcript status: 'completed' with 0 segments
- Meeting detail page: "This meeting had no transcribable speech"
- **No pipeline failure** - empty recording is valid outcome

### Pass Criteria
✅ Bot lifecycle completes without failure status  
✅ Empty transcript handled gracefully  
✅ No error logs or alerts for expected no-show scenario  

---

## Test Scenario 4: Multiple AMs (7 Calendar Coverage)

### Setup
- Verify 7 Account Managers have Microsoft calendars connected
- Schedule 3-4 meetings across different AMs at overlapping times

### Steps
1. Create meeting owned by AM #1, scheduled 5 minutes out
2. Create meeting owned by AM #2, scheduled 6 minutes out
3. Create meeting owned by AM #3, scheduled 7 minutes out
4. Confirm each meeting's `owner_membership_id` points to correct AM
5. Wait for bots to dispatch
6. Monitor admin meetings page for all meetings

### Expected Behavior
- Each meeting gets its own bot job (separate `meeting_bot_jobs` rows)
- Bot names personalized: "AW Echo · {FirstName}" per owner
- All bots can join concurrently (no hardcoded single-AM limit)
- Status tracking works independently for each meeting

### Pass Criteria
✅ All 3+ meetings show bot status correctly  
✅ No "already recording" conflicts between meetings  
✅ Each bot identified by owner's first name if available  

---

## Test Scenario 5: Lobby State Transitions (Edge Cases)

### Setup
Standard test meeting

### Steps
1. Wait for bot to arrive in lobby
2. Verify lobby warning appears
3. Admit bot
4. Verify warning clears and status = 'joined'
5. End meeting
6. Verify bot status = 'completed', lobby timestamp = null

### Database Verification
Query `meeting_bot_jobs` for test meeting:
```sql
SELECT 
  status, 
  lobby_waiting_since, 
  last_raw_status, 
  joined_at, 
  completed_at 
FROM meeting_bot_jobs 
WHERE meeting_id = '<test-meeting-id>'
ORDER BY generation DESC 
LIMIT 1;
```

Expected state progression:
1. `status='scheduled'`, `lobby_waiting_since=null`, `last_raw_status=null`
2. `status='joining'`, `lobby_waiting_since='2026-09-12T...'`, `last_raw_status='awaiting_admission'`
3. `status='joined'`, `lobby_waiting_since=null`, `last_raw_status='in_call_recording'`, `joined_at='2026-09-12T...'`
4. `status='completed'`, `lobby_waiting_since=null`, `left_at='2026-09-12T...'`

### Pass Criteria
✅ Database fields update correctly at each state transition  
✅ No stale `lobby_waiting_since` timestamps after bot joins  
✅ State machine progresses cleanly without stuck states  

---

## What This PR Does NOT Test (Out of Scope)

- ❌ Screen recording (not in Phase-1)
- ❌ Fireworks integration (not in Phase-1)
- ❌ Completeness scoring (not in Phase-1)
- ❌ Retry/re-admit automation (detect-only; manual admit is the fix)
- ❌ Native Teams bot registration (requires different integration approach)
- ❌ Auto-admit via Teams admin policy (tenant-level config, not code)

---

## Teams Admin Policy Note (For Ops)

**What Echo cannot fix in software:**
- Microsoft Teams lobby admission is enforced by the **host organization's tenant policy**, not ApplyWizz's code.
- For meetings ApplyWizz hosts: ApplyWizz IT can configure tenant policy to auto-admit bots (reduces lobby friction).
- For meetings customers host: ApplyWizz has **no control** over customer's tenant policy - bot will land in lobby and require manual admission by meeting organizer.

**What Echo CAN fix (this PR):**
- ✅ Detect lobby waiting state reliably
- ✅ Surface it to ops/admin/AMs within seconds (not silent failure)
- ✅ Clear instructions: "Admit AW Echo from lobby"
- ✅ Track how long bot has been waiting

**Recommendation:** For customer-hosted meetings, brief AMs during onboarding: "You'll need to admit the Echo bot from the lobby when it joins." This is a one-click action in Teams, not a technical limitation.
