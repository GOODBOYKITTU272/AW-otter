# Bot Avatar Activation Guide

**Status:** ✅ ACTIVE (Enabled 2026-09-13)  
**Validation:** Live probe confirmed Vexa accepts `bot_avatar_url` (201 status)  
**PR:** https://github.com/GOODBOYKITTU272/AW-otter/pull/32

## Current State

✅ **What's Live:**
- Bot display name: `"AW Echo · {FirstName}"` pattern working in Teams
- Avatar URL **actively sent** to Vexa API (`bot_avatar_url` field)
- Default URL: `https://echo.applywizz.ai/bot-avatar.png`
- Logo assets deployed: `apps/web/public/bot-avatar.png` and `logo.png`
- Environment override: `VEXA_BOT_AVATAR_URL` supported

✅ **Vexa API Confirmation (2026-09-13):**
- POST `/bots` with `bot_avatar_url` returns **201 Accepted**
- Field accepted even though OpenAPI schema is sparse
- PUT `/bots/.../avatar` still 404 (separate endpoint, not used)

## ✅ Already Activated (2026-09-13)

This guide was written before activation. Avatar functionality is now **live in production**.

### Live Probe Results

**Confirmed working via self-hosted Vexa:**
```bash
# POST /bots with bot_avatar_url field
# Result: 201 Accepted (field is accepted)
# Note: PUT /bots/.../avatar still returns 404 (not used)
```

**Step 2: Add Logo Asset**
- Source: Apply Wizz logo (request from design/brand team)
- Location: `apps/web/public/logo.png` (or similar)
- Format: PNG, square aspect ratio (256x256 or 512x512 recommended)
- Size: < 500KB for fast loading

**Step 3: Host Logo at Stable HTTPS URL**

Option A: Production domain (recommended)
```
https://echo.applywizz.ai/logo.png
```

Option B: CDN/Cloud Storage
```
https://cdn.applywizz.ai/assets/echo-logo.png
# OR
https://storage.googleapis.com/applywizz-assets/echo-logo.png
```

Requirements:
- ✅ HTTPS (required by Teams/Vexa)
- ✅ Publicly accessible (no auth required)
- ✅ Stable URL (won't change/break)
- ✅ CORS headers configured if needed
- ✅ Fast response time (< 500ms)

**Step 4: Uncomment Avatar URL in Vexa Client**

File: `packages/meeting-bots/src/vexa/client.ts`

```diff
  body: JSON.stringify({
    platform: "teams",
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    transcribe_enabled: false,
-   // bot_avatar_url: input.botAvatarUrl, // PREPARED: Uncomment when Vexa v0.12.x enables avatar API
+   ...(input.botAvatarUrl ? { bot_avatar_url: input.botAvatarUrl } : {}),
  }),
```

**Step 5: Pass Avatar URL from Domain Layer**

File: `packages/domain/src/meeting-bots.ts` (around line 383)

```diff
  const botName = generateBotDisplayName(ownerDisplayName);
+ const botAvatarUrl = "https://echo.applywizz.ai/logo.png"; // Or from config

  try {
    const result = await provider.createBot({
      meetingUrl: meeting.meeting_url,
      idempotencyKey: job.idempotency_key,
      botName,
+     botAvatarUrl,
    });
```

**Step 6: Add Environment Variable (Optional but Recommended)**

```bash
# .env
BOT_AVATAR_URL=https://echo.applywizz.ai/logo.png
```

Then use in code:
```typescript
const botAvatarUrl = process.env.BOT_AVATAR_URL || undefined;
```

**Step 7: Update Tests**

File: `packages/meeting-bots/src/vexa/client.test.ts`

```diff
  const result = await provider.createBot({
    meetingUrl: teamsUrl,
    idempotencyKey: "idem-1",
    botName: "AW Echo · Test",
-   // botAvatarUrl: "https://echo.applywizz.ai/logo.png",
+   botAvatarUrl: "https://echo.applywizz.ai/logo.png",
  });

  expect(JSON.parse(String(init?.body))).toEqual({
    platform: "teams",
    meeting_url: teamsUrl,
    bot_name: "AW Echo · Test",
    transcribe_enabled: false,
+   bot_avatar_url: "https://echo.applywizz.ai/logo.png",
  });
```

**Step 8: Test in Staging**
1. Deploy to staging environment
2. Schedule test meeting in Teams
3. Join meeting and verify bot shows Apply Wizz logo (not initials)
4. Check Teams participant roster for branded profile picture

**Step 9: Monitor Production**
- Check bot join success rate (should not change)
- Verify logo loads correctly in Teams
- Monitor Vexa API errors for avatar-related failures

## Important Notes

### Video Tile Still Blocked
Even with avatar API working, **custom video tile may not appear** due to Teams platform limitation (Vexa issue #124). The avatar URL sets the *profile picture* in the roster, not necessarily a video tile feed.

Expected behavior:
- ✅ Profile picture appears in participant list/roster
- ❌ Video tile may still show initials circle (Teams issue)

### Fallback Behavior
If `botAvatarUrl` is undefined or empty:
- Vexa uses default behavior (initials from bot_name)
- No errors or breaking changes
- Current "AW Echo · FirstName" pattern continues to work

### Performance Considerations
- Avatar URL is fetched by Teams/Vexa when bot joins
- Slow response (> 2s) may delay logo appearing
- Consider CDN for reliability

## Rollback Plan

If avatar causes issues:

**Quick Rollback:**
```typescript
// packages/domain/src/meeting-bots.ts
const botAvatarUrl = undefined; // Disable avatar temporarily
```

**Full Rollback:**
Re-comment the bot_avatar_url line in Vexa client:
```typescript
// bot_avatar_url: input.botAvatarUrl, // Disabled: rollback to initials
```

## References

- Investigation doc: `docs/product/bot-branding-investigation.md`
- Vexa API docs: https://docs.vexa.ai/api/interactive-bots
- Vexa issue #124: https://github.com/Vexa-ai/vexa/issues/124
- Bot name generator: `packages/domain/src/bot-name.ts`
