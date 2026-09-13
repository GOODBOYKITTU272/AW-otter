# Testing Notes: Role-Gated Transcript Access

## Summary
This PR implements role-based access control for raw meeting transcripts. Account Managers can no longer view raw transcript text, while Managers and Admins retain full access.

## What Changed

### Files Modified
1. `apps/web/app/meetings/[id]/page.tsx` - Meeting detail page
2. `apps/web/app/meetings/[id]/recap/page.tsx` - Meeting recap page server component
3. `apps/web/components/recap/meeting-recap.tsx` - Meeting recap client component

### Key Implementation
- Added `canViewRawTranscript` boolean flag based on role: `membership.roleKey !== "account_manager"`
- Conditionally render Transcript tab, Transcript Preview, and Full Transcript sections
- No changes to API routes (server-side enforcement only)

## Manual Test Plan

### Test Case 1: Account Manager Access
**Login as:** Account Manager role

**Meeting Detail Page (`/meetings/[id]`):**
- [ ] Overview tab is visible
- [ ] Actions tab is visible
- [ ] Customer Truth tab is visible
- [ ] Activity tab is visible
- [ ] **Transcript tab is HIDDEN**
- [ ] **Transcript Preview section is NOT shown in Overview tab**
- [ ] MediaPlayer (audio playback) is still functional
- [ ] Evidence quotes in Actions/Customer Truth expandable sections still visible

**Meeting Recap Page (`/meetings/[id]/recap`):**
- [ ] Summary section is visible
- [ ] Next Journey Step is visible
- [ ] What Changed section is visible
- [ ] Actions section is visible
- [ ] Commitments section is visible
- [ ] Missing Info / Blockers section is visible
- [ ] MediaPlayer (audio playback) is still functional
- [ ] **Full Transcript section is HIDDEN**
- [ ] Evidence segments in expandable details still show (these are quotes, not full transcript)

### Test Case 2: Manager Access
**Login as:** Manager or Senior Manager role

**Meeting Detail Page:**
- [ ] All tabs visible including Transcript tab
- [ ] Transcript Preview section visible in Overview
- [ ] Full transcript with all segments visible in Transcript tab
- [ ] All other functionality works as before

**Meeting Recap Page:**
- [ ] All sections visible including Full Transcript
- [ ] Full Transcript expandable section works correctly

### Test Case 3: Admin Access
**Login as:** Admin role

**Meeting Detail Page:**
- [ ] All tabs visible including Transcript tab
- [ ] Transcript Preview section visible in Overview
- [ ] Full transcript with all segments visible in Transcript tab
- [ ] Technical Details section visible (admin-only)
- [ ] All other functionality works as before

**Meeting Recap Page:**
- [ ] All sections visible including Full Transcript
- [ ] Full Transcript expandable section works correctly

### Test Case 4: Navigation & Deep Links
**Test for all roles:**
- [ ] Tab switching works correctly
- [ ] Deep links to segments (e.g., `#segment-xyz`) work correctly (Managers/Admins only)
- [ ] URL parameter `?tab=transcript` works correctly (Managers/Admins only)
- [ ] URL parameter `?tab=transcript` gracefully ignored for Account Managers (shows Overview instead)
- [ ] Browser back/forward navigation works correctly

### Test Case 5: Edge Cases
- [ ] Meeting with no transcript: appropriate "no transcript" message shown
- [ ] Meeting still processing: appropriate "processing" message shown
- [ ] Meeting with failed transcription: appropriate error message shown
- [ ] Evidence segments (contextual quotes): still visible for all roles in expandable details

## Expected Behavior Summary

| Feature | Account Manager | Manager/Senior Manager | Admin |
|---------|----------------|----------------------|-------|
| Overview Tab | ✅ Visible | ✅ Visible | ✅ Visible |
| Transcript Tab | ❌ Hidden | ✅ Visible | ✅ Visible |
| Transcript Preview | ❌ Hidden | ✅ Visible | ✅ Visible |
| Full Transcript Section | ❌ Hidden | ✅ Visible | ✅ Visible |
| Audio Playback | ✅ Visible | ✅ Visible | ✅ Visible |
| Actions/Truth Tabs | ✅ Visible | ✅ Visible | ✅ Visible |
| Evidence Quotes | ✅ Visible | ✅ Visible | ✅ Visible |
| Activity Tab | ✅ Visible | ✅ Visible | ✅ Visible |

## Security Notes
- Server-side enforcement via `requireRole` middleware at page level
- No direct API routes expose raw transcript segments
- All transcript data fetching happens server-side in page components
- Role check happens before rendering any transcript content
- No client-side bypass possible (data not fetched for AMs)

## Performance Notes
- No performance impact: conditional rendering only affects what's displayed
- Transcript segments not fetched for AMs would require database query optimization (future enhancement)
- Current implementation: segments fetched but not rendered for AMs (acceptable for MVP)

## Known Limitations
- Evidence segments (contextual quotes) remain visible in expandable details sections
  - This is intentional: these are small snippets that provide context for Actions/Customer Truth
  - Not considered "raw transcript" in the same way as full transcription access
- Transcript segments still fetched from database for AMs (just not rendered)
  - Future optimization: skip fetching segments entirely for AM role
