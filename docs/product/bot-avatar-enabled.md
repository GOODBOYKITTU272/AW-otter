# Bot Avatar Enabled (2026-09-13)

**Status:** ✅ Active in production  
**PR:** https://github.com/GOODBOYKITTU272/AW-otter/pull/32

## What Was Enabled

Apply Wizz Echo bots now send a `bot_avatar_url` field when creating meeting bots through Vexa. This provides branded presence in Teams meetings with the Apply Wizz logo.

### Changes Made

1. **Bot Avatar Assets**
   - Created circular bot avatar: `apps/web/public/bot-avatar.png`
   - Created logo alias: `apps/web/public/logo.png` (same asset)
   - Both served at:
     - `https://echo.applywizz.ai/bot-avatar.png`
     - `https://echo.applywizz.ai/logo.png`

2. **Code Changes**
   - **Vexa Client** (`packages/meeting-bots/src/vexa/client.ts`): Now sends `bot_avatar_url` field when provided in `CreateBotInput`
   - **Domain Layer** (`packages/domain/src/meeting-bots.ts`): `processPendingBotJobs()` accepts and passes `botAvatarUrl` parameter
   - **Route Handler** (`apps/web/app/api/internal/meeting-bots/tick/route.ts`): Calls `getBotAvatarUrl()` and passes it to domain functions
   - **Environment Config** (`apps/web/env/server.ts`): New `getBotAvatarUrl()` function with default and override support

3. **Default Behavior**
   - Avatar URL: `https://echo.applywizz.ai/bot-avatar.png` (served from `apps/web/public/`)
   - Sent on every bot creation
   - No breaking changes — field is optional, omitted when undefined

## How It Works

### Fireflies-Style Branding

Similar to Fireflies/Fathom notetakers, Echo bots now present branded presence:
- **Bot name:** `"AW Echo · {FirstName}"` (already live)
- **Avatar URL:** Apply Wizz logo sent to Vexa's bot creation API
- **Teams tile:** Depends on Vexa applying the avatar (platform behavior)

### Environment Override

To customize or disable the avatar URL:

```bash
# Custom URL (e.g., for staging or alternate branding)
VEXA_BOT_AVATAR_URL=https://staging.applywizz.ai/test-avatar.png

# Disable avatar (empty string)
VEXA_BOT_AVATAR_URL=
```

**Important:** The default value is compiled into the code (`getBotAvatarUrl()` in `apps/web/env/server.ts`). To change it permanently, update the function's default return value.

## Platform Status

### ✅ Vexa API Confirmation (2026-09-13 Live Probe)

**Self-hosted Vexa validates this works:**
- POST `/bots` with `bot_avatar_url` returns **201 Accepted**
- Field is accepted even though OpenAPI schema is sparse
- PUT `/bots/.../avatar` still returns 404 (separate endpoint, not used)

### What This Enables
- ✅ Bot name: `"AW Echo · {FirstName}"` (already live)
- ✅ Avatar URL accepted by Vexa API (confirmed via live probe)
- ⏳ Teams tile branding (depends on Vexa/Teams rendering the image)

### Known Limitations
- Teams video tile requires separate platform fix (Vexa issue #124)
- Avatar display in Teams participant list depends on Vexa applying the URL
- Vexa OpenAPI docs are sparse (field works but not documented)

## What to Monitor

### Expected Outcomes

- ✅ Vexa accepts `bot_avatar_url` field (201 status confirmed via live probe)
- ✅ Bot creation success rate remains unchanged
- ⏳ Teams meetings show Apply Wizz logo in participant list (when Vexa/Teams render it)

### Potential Issues

1. **Avatar not visible in Teams**
   - **Symptom:** Bot joins successfully but shows initials circle instead of logo
   - **Likely cause:** Vexa accepts field (201) but Teams/Vexa rendering may not apply it yet
   - **Action:** Monitor Teams participant list; code is working, rendering depends on platform
   - **Reference:** `docs/product/bot-branding-investigation.md`

2. **Bot creation failures**
   - **Symptom:** Increased `failed` job count in tick results
   - **Check:** Bot creation logs for Vexa API errors mentioning `bot_avatar_url`
   - **Rollback:** Set `VEXA_BOT_AVATAR_URL=` (empty) to disable without code changes

3. **Avatar URL not reachable**
   - **Symptom:** Slow bot joins, Vexa timeouts fetching avatar
   - **Check:** `https://echo.applywizz.ai/bot-avatar.png` returns 200 OK
   - **Fix:** Verify Next.js static serving, CDN/proxy configuration

## Platform Limitations

### What This Does NOT Enable

- **Video tile with logo:** Still blocked by Teams platform limitation (Vexa issue #124)
- **Guaranteed avatar display:** Vexa API behavior not confirmed until they document/enable it

### Known Unknowns

- Vexa may silently accept `bot_avatar_url` field without applying it (optimistic send)
- Teams may require Vexa avatar API to be fully enabled (currently returns 404 as of 2026-09-12)
- Video tile presence requires separate Teams fix beyond avatar URL alone

## Rollback Plan

### Quick Disable (No Deploy)

```bash
# Set environment variable to empty string
VEXA_BOT_AVATAR_URL=
```

This disables avatar sending immediately without code changes or deployment.

### Code Rollback

If avatar URL causes production issues:

1. **Revert environment config:**
   ```diff
   - return envValue ?? "https://echo.applywizz.ai/bot-avatar.png";
   + return undefined; // Disable avatar URL
   ```

2. **Revert Vexa client:**
   ```diff
   - ...(input.botAvatarUrl ? { bot_avatar_url: input.botAvatarUrl } : {}),
   + // bot_avatar_url: input.botAvatarUrl, // Disabled: rollback
   ```

3. Deploy and verify bots join without avatar field

## Success Criteria

- ✅ No increase in bot creation failure rate
- ✅ Avatar URL field sent in Vexa API payload (verified in tests)
- ✅ Production assets served successfully (200 OK)
- ⏳ Teams participant list shows Apply Wizz logo (depends on Vexa platform)

## References

- Investigation: `docs/product/bot-branding-investigation.md`
- Activation guide: `docs/product/bot-avatar-activation-guide.md`
- Vexa API: https://docs.vexa.ai/api/interactive-bots
- Teams bot presence: Depends on Vexa applying avatar (not confirmed as of v0.12)

## Next Steps (Future Work)

1. **Monitor Vexa release notes** for avatar API availability confirmation
2. **Test in production** to confirm Teams shows logo when Vexa enables it
3. **Investigate video tile** if avatar works but video presence still shows initials (separate Teams issue)
4. **Add monitoring** for avatar URL fetch success rate if Vexa exposes metrics
