# Dummy Data Removal Audit

**Date:** 2026-09-15  
**Branch:** cursor/remove-all-dummy-data-e245  
**Auditor:** Cloud Agent

## Executive Summary

**Result:** ✅ **APP IS CLEAN** - No dummy data found in production UI paths.

All customer-facing pages pull from real database queries or display honest empty states. The only test data exists in clearly-labeled development-only fixtures and seed files.

---

## Areas Audited

### ✅ 1. AM Home Page (`/home`)
**Status:** CLEAN - All real data or honest empty states

**Checked:**
- Live alerts: ✅ Real DB via `getAMLiveAlerts()` from `operational_incidents` table
- Next call: ✅ Real DB from `meetings` + `customers` tables  
- Needs attention: ✅ Real DB from `getPortfolioOverview()`
- Today's meetings: ✅ Real DB, empty state shows "No customer calls scheduled today"
- Overdue/due soon: ✅ Real DB from `getPortfolioActionQueue()`
- Recent changes: ✅ Real DB from `customer_truth_facts` + `call_records`
- Upcoming renewals: ✅ Real DB, empty state shows "No upcoming renewals in the next 30 days"
- Upcoming customer calls: ✅ Component queries DB
- Recent conversations: ✅ Real DB from `listRecentMeetingSummaries()`

**No hardcoded meetings, customers, or alert counts found.**

### ✅ 2. Manager Board (`/manager/board`)
**Status:** CLEAN - All real data or honest empty states

**Checked:**
- AM metrics (meetings, calls, no-shows, lobby): ✅ Real DB aggregated from `meetings`, `meeting_bot_jobs`, `meeting_attendees`
- Live alerts sidebar: ✅ Real DB via `getManagerLiveAlerts()`
- Empty state: ✅ Shows "No Account Managers found in your team" when empty
- Team filters: ✅ UI only (no hardcoded team names in data)

**No fake AM names, invented metrics, or dummy alert counts.**

### ✅ 3. Manager Overview (`/manager/overview`)  
**Status:** CLEAN - All real data

**Checked:**
- Live alerts: ✅ Real DB via `getManagerLiveAlerts()`
- Team stats: ✅ Computed from real `getPortfolioOverview()`
- Needs attention: ✅ Real DB, empty state shows "All customer accounts... are healthy"
- Customer risks & renewals: ✅ Real DB, empty state shows "No near-term renewal risks..."

**No hardcoded portfolio data or fake customer risks.**

### ✅ 4. Admin Overview (`/admin/overview`)
**Status:** CLEAN - All real data or "Not metered" labels

**Checked:**
- System health & spend: ✅ Real DB from `meeting_transcripts`, `ai_runs`, counts
- AI services (Vexa, Whisper, Sarvam, Azure): ✅ Real usage from DB, shows "Not metered yet" when no data
- AI token usage: ✅ Real DB aggregation from `ai_runs.usage_metadata`
- Monthly budget: ✅ Real spend calculation, shows "Not metered yet" when zero
- Recent incidents: ✅ Real DB from `operational_incidents`, empty state shows "No recent incidents"

**Previous admin fixes (M13) already removed invented spend/metrics - confirmed still honest.**

### ✅ 5. Actions Page (`/actions`)
**Status:** CLEAN - All real data

**Checked:**
- Action items: ✅ Real DB from `call_records` where status = 'detected'
- Customer names: ✅ Resolved from `customers` table
- Owner names: ✅ Resolved from `organization_memberships` table
- Empty state: ✅ Shows "Nothing outstanding."

**No fake actions or invented commitments.**

### ✅ 6. Manager Meetings (`/manager/meetings`)
**Status:** CLEAN - All real data

**Checked:**
- Team meetings list: ✅ Real DB from `meetings` joined with `customers`, `organization_memberships`
- Empty states present for zero data cases

### ✅ 7. Admin Meetings (`/admin/meetings`)  
**Status:** CLEAN - All real data

**Checked:**
- Meetings list: ✅ Real DB queries with customer/owner lookups
- No hardcoded meeting arrays

### ✅ 8. Meeting Detail Pages (`/meetings/[id]`, `/meetings/[id]/recap`)
**Status:** CLEAN - All real data

**Checked:**
- Meeting recap: ✅ Real DB via `getMeetingRecapData()`
- Transcripts: ✅ Real DB from `transcript_segments`
- Intelligence: ✅ Real DB from meeting intelligence tables

---

## Live Alerts Implementation

**Source:** `packages/domain/src/live-alerts.ts`

✅ **CONFIRMED REAL:**
- `getAMLiveAlerts()`: Queries `operational_incidents` table filtered by `meeting_id` IN (AM's meetings)
- `getManagerLiveAlerts()`: Queries `operational_incidents` for direct reports' meetings
- Alert detection: `detectLobbyAlerts()` and `detectCustomerMissingAlerts()` run by background job
- **No fake alert constants or invented "URGENT 4 Live Alerts" counts**

Alert counts are always:
- Zero if no real incidents in DB
- Real count from `operational_incidents` table when alerts exist

---

## Seed & Test Data

### ✅ seed.sql (dev-only)
**Location:** `supabase/seed.sql`  
**Status:** Clearly marked LOCAL DEV ONLY

**Changes made:**
1. Added prominent warning banner at top
2. Added SQL production safety check that errors if run against non-dev database
3. Confirmed Supabase production deployments never run seed.sql (migrations only)

**Test organizations:**
- `Organization A (Test)` / `org-a-test` / @org-a.test emails
- `Organization B (Test)` / `org-b-test` / @org-b.test emails
- Test UUIDs: `00000000-0000-0000-0000-0000000000a1`, `00000000-0000-0000-0000-0000000000b1`

**Verified:**
- ✅ No production code references these test UUIDs or organizations
- ✅ No deployment scripts run seed.sql
- ✅ CI workflow (`ci.yml`) runs `supabase start` locally for tests only

### ✅ Test Fixtures
**Location:** `apps/web/fixtures/meeting-intelligence/fixtures.ts`

**Status:** Clearly labeled "fixture-only (no DB calls), useful for visual regression / component tests"

Test names found (fixture-only):
- "Priya Nair", "Anika Rao", "Maya Patel" (in fixtures.ts)
- "Jane Doe", "Ada Admin" (in test files normalize.test.ts, ask-signal-panel.test.ts)

**Verified:**
- ✅ All test names are in test files or fixture modules only
- ✅ Zero references in production page code

---

## Database Migrations

**Status:** CLEAN - Only system reference data

**Checked:**
- `20260906020003_roles_and_permissions.sql`: ✅ System roles/permissions only (admin, manager, AM)
- `20260906020026_meeting_policy_bootstrap.sql`: ✅ Policy rules bootstrap only

**No dummy customer, meeting, or employee data in migrations.**

---

## Code Patterns Verified

### Searches performed:
```bash
# Customer/company names
Amazon, Google, Microsoft Corp, Acme, Contoso, Fabrikam, Northwind
❌ No matches in production code

# People names  
Arjun, Priya, Rahul, Sarah, John, Jane
❌ No matches in production code (test files only)

# Hardcoded arrays
const.*meetings.*=.*\[, const.*customers.*=.*\[, const.*alerts.*=.*\[
❌ No hardcoded data arrays found in production pages

# Demo flags
isDemo, isDemoMode, showDemo, useMock, mockData
❌ No demo mode flags found

# Mock data constants
DEMO, SAMPLE, MOCK_, FAKE_, hardcoded
❌ Only in test files and comments
```

### Database query patterns:
```typescript
// All pages follow this pattern:
const { data: customers } = await supabase.from("customers").select("...");
const meetings = await getPortfolioOverview(...);
const alerts = await getAMLiveAlerts(...);
```

✅ **Every production page uses real Supabase queries or domain functions that query the DB.**

---

## Empty State Messages (Verified Honest)

| Page | Empty State | Status |
|------|-------------|--------|
| AM Home - Meetings | "No customer calls scheduled today" | ✅ Honest |
| AM Home - Attention | "Nothing needs attention right now" | ✅ Honest |
| AM Home - Actions | "No overdue actions" | ✅ Honest |
| AM Home - Changes | "No recent changes" | ✅ Honest |
| AM Home - Renewals | "No upcoming renewals in the next 30 days" | ✅ Honest |
| AM Home - Conversations | "No recent conversations with intelligence ready yet" | ✅ Honest |
| Manager Board - AMs | "No Account Managers found in your team" | ✅ Honest |
| Manager Board - Alerts | "All clear! No active alerts for your team" | ✅ Honest |
| Manager Overview - Attention | "All customer accounts in your reporting line are healthy" | ✅ Honest |
| Manager Overview - Risks | "No near-term renewal risks or customer blockers detected" | ✅ Honest |
| Admin Overview - Spend | "Not metered yet" (when zero) | ✅ Honest |
| Admin Overview - Incidents | "No recent incidents" | ✅ Honest |
| Actions | "Nothing outstanding" | ✅ Honest |

**No invented metrics, fake customers, or placeholder meetings shown when data is empty.**

---

## Constraints Met

✅ Keep RoleShell brand (dark shell + white light cards) from PR #55/#56 - UNCHANGED  
✅ Keep auth/role gates - UNCHANGED  
✅ Do NOT delete real customer/meeting rows from production Supabase - NOT TOUCHED  
✅ Unit/integration tests may keep fixtures labeled as test-only - KEPT  
✅ No invented metrics to fill empty dashboards - CONFIRMED NONE  
✅ Owner prefers plain English empty states - ALREADY IN PLACE  

---

## Changes Made

1. **Enhanced seed.sql protection:**
   - Added prominent warning banner
   - Added SQL production safety check
   - Clarified Supabase deployment behavior

**Total files modified:** 1 (`supabase/seed.sql`)

---

## Conclusion

**The Apply Wizz Echo application is production-ready with zero dummy data in shipped UI paths.**

Every dashboard, board, overview, and detail page:
- Queries real database tables via Supabase client or domain functions
- Shows honest empty states when no data exists
- Never falls back to hardcoded sample data
- Never displays invented customers, meetings, AMs, metrics, spend, or alerts

The only test data exists in:
- `supabase/seed.sql` (local dev only, now with extra safeguards)
- Test fixtures in `fixtures/` and `*.test.ts` files (never imported by production pages)

**Ready for customer meetings with confidence.**
