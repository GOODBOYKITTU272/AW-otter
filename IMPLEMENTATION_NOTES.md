# Fathom-Style Meeting Detail Implementation

## Overview

This PR rebuilds the Meeting Detail page with a Fathom-style tabbed interface and adds a lightweight Meeting Outcome LLM pipeline for generating structured Overview content.

## Changes

### 1. Database Schema

**New table: `meeting_outcomes`**
- Stores lightweight Overview-tab content (summary, key decisions, action items, open questions)
- One outcome per meeting (latest always wins)
- Generated via separate LLM prompt, distinct from full meeting intelligence
- Located at: `supabase/migrations/20260914010001_meeting_outcomes_fathom_style.sql`

### 2. Meeting Outcome LLM Pipeline

**New AI Provider: `OpenRouterMeetingOutcomeProvider`**
- Simpler than full meeting intelligence extraction
- Focused prompt for Fathom-style overview data
- Returns structured JSON: summary, keyDecisions, actionItems, openQuestions
- Each extracted item includes evidence segment IDs for traceability
- Located at: `packages/ai/src/openrouter-outcome.ts`

**Pipeline Flow:**
```
Teams Recording → Vexa Audio → STT (Whisper/Sarvam) → Canonical English → Meeting Outcome LLM → Structured Overview
```

### 3. Meeting Detail UI Restructure

**New Tab Structure:**
- **Overview** (default): Structured cards showing Summary, Key Decisions, Action Items, Open Questions
- **Audio**: Audio player when available
- **Video**: Video player when screen recording available (Path C)
- **Transcript**: Raw transcript segments (role-gated to Manager/Admin only)
- **Insights**: Consolidated view of actions and customer truth updates

**Role Gates:**
- Account Managers: Can see Overview, Audio, Video, Insights — NO Transcript
- Managers/Admins: Can see all tabs including Transcript

### 4. Domain & API

**Domain Functions:**
- `getMeetingOutcome()`: Fetches meeting outcome for display
- `enqueuePendingOutcomeGeneration()`: Finds completed transcripts without outcomes
- `processOutcomeQueue()`: Generates outcomes via LLM

**API Route:**
- `/api/internal/meeting-outcome/process`: Background worker endpoint
- Follows same pattern as meeting-intelligence worker
- Called by cron/scheduler to process pending outcomes

## Testing

### Local Development

1. **Database migration:**
   ```bash
   supabase db reset
   ```

2. **Start dev server:**
   ```bash
   pnpm dev
   ```

3. **Visit a meeting:**
   Navigate to `/meetings/[id]` to see the new tab structure

4. **Trigger outcome generation (manual):**
   ```bash
   curl -X POST http://localhost:3000/api/internal/meeting-outcome/process \
     -H "Authorization: Bearer YOUR_INTERNAL_SECRET"
   ```

### Verification Checklist

- [ ] Meeting Detail page shows tabs: Overview, Audio, Video, Transcript (role-gated), Insights
- [ ] Overview tab displays structured cards (Summary, Key Decisions, Action Items, Open Questions)
- [ ] Audio/Video tabs show media player when available
- [ ] Transcript tab is hidden for Account Managers
- [ ] Transcript tab is visible for Managers/Admins
- [ ] Meeting outcomes are generated automatically by background worker
- [ ] Evidence segment IDs link to transcript segments

## Empty `meeting_outcomes` is expected

`SELECT * FROM meeting_outcomes` returning **Success. No rows returned** is correct until:

1. The `20260914010001_meeting_outcomes_fathom_style` migration is applied to that database.
2. `/api/internal/meeting-intelligence/process` (existing cron) or `/api/internal/meeting-outcome/process` runs.

Overview does **not** wait on that table. It derives Summary / Decisions / Action items / Open questions from existing `ai_runs` + `call_records` when no outcome row exists.

## What's Wired vs Stubbed

### ✅ Fully Wired
- Database schema for `meeting_outcomes`
- Meeting Outcome LLM provider (OpenRouter)
- Domain functions for fetching and generating outcomes
- API route for background worker
- UI tab structure and role gates
- Overview tab showing structured outcome data
- Audio/Video tabs with media player integration
- Transcript tab with existing segment display
- Insights tab consolidating actions and truth updates

### 🚧 Stubbed / Future Work
- **Regenerate UI**: Currently outcomes are generated once; no UI button to regenerate
- **Editable Save**: No UI for manually editing outcomes yet
- **"Needs Review" segments**: Mentioned in requirements but not yet wired to link from Overview to Transcript
- **Insights tab analytics**: Basic layout present, could be enhanced with charts/metrics
- **Outcome generation trigger**: Currently manual via API; should be integrated into transcript completion flow

## Production Deployment

1. **Database migration** will run automatically via Supabase
2. **Environment variables** should already be set:
   - `OPENROUTER_API_KEY`: Required for LLM generation
   - `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Service role key for worker
3. **Background worker**: Set up cron job to call `/api/internal/meeting-outcome/process` every 1-5 minutes
4. **Monitor**: Check worker logs for generation errors

## Tech Stack

- **Database**: PostgreSQL (Supabase)
- **LLM Provider**: OpenRouter
- **UI Framework**: Next.js App Router
- **Styling**: CSS Modules (following existing Echo Admin brand tokens)
- **Type Safety**: TypeScript + Zod schemas

## Files Changed

### New Files
- `supabase/migrations/20260914010001_meeting_outcomes_fathom_style.sql`
- `packages/ai/src/openrouter-outcome.ts`
- `packages/domain/src/meeting-outcome.ts`
- `packages/domain/src/meeting-outcome-generation.ts`
- `apps/web/app/api/internal/meeting-outcome/process/route.ts`

### Modified Files
- `packages/ai/src/types.ts` - Added Meeting Outcome schemas
- `packages/ai/src/index.ts` - Exported new provider
- `packages/domain/src/index.ts` - Exported new domain functions
- `apps/web/app/meetings/[id]/page.tsx` - Rebuilt with new tab structure

## Notes

- Meeting Outcome extraction is **separate from** full meeting intelligence (ai_runs)
- Outcome is **lighter-weight** and focused on Overview display only
- Full intelligence still runs for actions/decisions/customer-truth extraction
- Outcome generation should complete faster than full intelligence
- STT model display (Whisper vs Sarvam) is handled by existing transcript metadata — no changes needed for this PR

## Open Questions / Future Enhancements

1. Should outcome generation be triggered inline with transcript completion, or remain async?
2. Should we add a "Regenerate" button in the UI for manual refresh?
3. Should "needs review" segments get highlighted/linked in Overview cards?
4. Should Account Managers see audio player in Overview sidebar, or only in Audio tab?
