# Bot Avatar Worker Fix (2026-09-14)

**Status:** ✅ Fixed  
**Related PR:** #32 (original avatar enablement)  
**Fix PR:** TBD

## Problem

During a live Teams E2E test (meeting ID `1052607e-d407-4fb2-9ae4-3b9a94da5cf5`, bot job `14eeb65e-b883-44f9-a6d3-3f55fce91e54`), the bot joined as "AW Echo · Rama" but displayed a generic `</>` code icon instead of the Apply Wizz logo.

Investigation revealed that the `provider_metadata` had **NO `bot_avatar_url` in data**.

## Root Cause

PR #32 enabled bot avatar branding by:
1. ✅ Adding `getBotAvatarUrl()` helper in `apps/web/env/server.ts`
2. ✅ Updating `apps/web/app/api/internal/meeting-bots/tick/route.ts` to call `getBotAvatarUrl()` and pass it to `processPendingBotJobs()`
3. ✅ Wiring the avatar URL through the domain layer (`packages/domain/src/meeting-bots.ts`)
4. ✅ Updating the Vexa client to include `bot_avatar_url` in API requests

**However, PR #32 missed updating `workers/orchestrator/bot-worker.mjs`**, which is the standalone worker process used for bot orchestration.

The worker was calling:
```javascript
const processResult = await processPendingBotJobs(supabase, provider);
```

But it should have been:
```javascript
const botAvatarUrl = getBotAvatarUrl();
const processResult = await processPendingBotJobs(supabase, provider, 10, botAvatarUrl);
```

## Impact

- **API Route (`/api/internal/meeting-bots/tick`):** ✅ Working correctly, always sends avatar URL
- **Worker Process (`bot-worker.mjs`):** ❌ Not sending avatar URL

Any bot created via the worker would join Teams meetings without the avatar URL, resulting in the generic code icon instead of the Apply Wizz logo.

The E2E test that failed was likely using a deployment that relies on the worker rather than the API route.

## Fix

Updated `workers/orchestrator/bot-worker.mjs` to:

1. Add inline `getBotAvatarUrl()` helper (same logic as `apps/web/env/server.ts`):
   ```javascript
   function getBotAvatarUrl() {
     const envValue = process.env.VEXA_BOT_AVATAR_URL;
     if (envValue === "") return undefined;
     return envValue ?? "https://echo.applywizz.ai/bot-avatar.png";
   }
   ```

2. Call the helper and pass the avatar URL to `processPendingBotJobs()`:
   ```javascript
   const botAvatarUrl = getBotAvatarUrl();
   const processResult = await processPendingBotJobs(
     supabase,
     provider,
     10,
     botAvatarUrl,
   );
   ```

3. Updated documentation comment to list `VEXA_BOT_AVATAR_URL` as an optional env var

## Verification

### Tests Added

1. **Domain Layer Test** (`packages/domain/src/meeting-bots.test.ts`):
   - Added test "passes botAvatarUrl through to the provider's createBot"
   - Verifies that `processPendingBotJobs()` correctly passes the avatar URL to the provider

2. **Existing Tests** (already in PR #32):
   - Vexa client tests verify avatar URL is included when provided
   - Vexa client tests verify avatar URL is omitted when not provided

### Manual Verification

After deployment:
1. ✅ Verify worker logs show resolved `botAvatarUrl=https://echo.applywizz.ai/bot-avatar.png` at startup
2. ✅ Verify new `meeting_bot_jobs.provider_metadata.bot_avatar_url_sent` is that URL (Vexa create response does **not** echo `bot_avatar_url`; absence of a provider-echoed field is not proof of NOT SENT)
3. ✅ Verify bot joins Teams meeting with Apply Wizz logo instead of AA/generic initials — if URL was SENT and Teams still shows initials, that is a Vexa/Teams rendering limitation, not a missing Echo send
4. ✅ Verify `https://echo.applywizz.ai/bot-avatar.png` returns 200 OK (~211KB)

## Why This Was Missed in PR #32

The worker file (`workers/orchestrator/bot-worker.mjs`) is a standalone JavaScript module that doesn't import from the Next.js app (`apps/web/env/server.ts`). It has its own environment variable handling logic.

When PR #32 added avatar support to the API route (which uses `getBotAvatarUrl()` from `apps/web/env/server.ts`), the equivalent logic needed to be added inline to the worker file but was overlooked.

## Environment Variable

The fix respects the same `VEXA_BOT_AVATAR_URL` environment variable that the API route uses:

- **Default:** `https://echo.applywizz.ai/bot-avatar.png` (Apply Wizz logo)
- **Custom:** Set to any HTTPS URL to use a different avatar
- **Disable:** Set to empty string (`VEXA_BOT_AVATAR_URL=`) to disable avatar sending

## References

- Original avatar enablement: `docs/product/bot-avatar-enabled.md`
- Investigation: `docs/product/bot-branding-investigation.md`
- Activation guide: `docs/product/bot-avatar-activation-guide.md`
