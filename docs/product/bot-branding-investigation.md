# Bot Branding Investigation: Teams Meeting Presence

**Investigation Date:** 2026-09-12  
**Goal:** Implement Fathom-style branded bot presence with Apply Wizz logo and status text  
**Baseline:** Current bot shows as "AW Echo · {FirstName}" display name only

## Investigation Results

### Vexa API Current Capabilities (v0.12)

Investigated Vexa's open-source repository and API documentation at docs.vexa.ai:

#### ✅ Currently Supported

**Bot Display Name** (`bot_name` field)
- Sent in POST /bots request body
- Appears as participant name in Teams meeting
- Successfully implemented: `"AW Echo · {FirstName}"` pattern
- Character limit: Teams supports up to ~256 characters

**Fields confirmed working:**
```json
{
  "platform": "teams",
  "meeting_url": "<Teams join URL>",
  "bot_name": "AW Echo · John",
  "transcribe_enabled": false
}
```

#### ❌ Not Available Yet

**Avatar/Profile Picture** (`PUT /bots/{platform}/{id}/avatar`)
- Endpoint exists in API specification
- **Status:** Returns 404 in current v0.12 release
- Per docs.vexa.ai/api/interactive-bots: "Avatar / virtual camera: sealed ❌ 404 - planned back in 0.12.x"
- Vexa documentation confirms: "contract-sealed but not reachable through the API today"

**Custom Video Tile**
- Teams actively blocks bot video publishing (GitHub issue #124)
- Remote SDP returns `m=video 0, a=inactive`
- Symptoms: Bot appears with initials circle, not video tile
- Root cause: Teams-side negotiation/policy rejection
- Even when Vexa's avatar API is enabled, Teams video publishing requires separate resolution

### Comparison: Fathom Bot Presence

Fathom/Apify notetakers show:
- ✅ Logo/avatar image (profile picture)
- ✅ Status text: "Recording and taking notes"
- ✅ Branded video tile in meeting

**What Echo Can Match Today:**
- ✅ Display name with branding: "AW Echo · {FirstName}"
- ❌ Logo/avatar: **Requires Vexa avatar API** (not yet available)
- ❌ Video tile with logo: **Requires both Vexa avatar API AND Teams video publishing fix**

## Implementation Status

### ✅ Currently Live

1. **Bot Display Name Pattern**
   - Implementation: `packages/domain/src/bot-name.ts`
   - Format: `"AW Echo · {FirstName}"` or `"AW Echo"` (fallback)
   - Tests: `packages/domain/src/bot-name.test.ts`
   - Production-ready and working

### 🚧 Prepared Infrastructure (Not Active)

2. **Avatar URL Support (Infrastructure Ready)**
   - Type definitions updated to include `botAvatarUrl?: string`
   - Vexa client prepared to send field when API supports it
   - Logo asset location identified: `apps/web/public/logo_Applywizz.png` (to be added)
   - Commented infrastructure in `packages/meeting-bots/src/types.ts`
   - Zero production impact: field not sent until explicitly enabled

### ❌ Blocked by Platform

3. **Custom Video Tile**
   - Requires: Vexa avatar API (ETA: 0.12.x series)
   - Requires: Teams video publishing fix (Vexa issue #124)
   - No implementation possible at application level

## Recommendations

### Immediate (This PR)
1. ✅ Keep existing `"AW Echo · {FirstName}"` display name pattern
2. ✅ Document Vexa API limitations clearly
3. ✅ Prepare avatar URL infrastructure (commented, inactive)
4. ✅ No changes to active bot behavior

### When Vexa Enables Avatar API (Future)
1. Add Apply Wizz logo to public assets
2. Host logo at stable HTTPS URL (e.g., `https://echo.applywizz.ai/logo.png` or CDN)
3. Uncomment avatar URL fields in types
4. Enable avatar URL in Vexa client payload
5. Test avatar appears in Teams meeting roster
6. Note: Video tile still may not work (separate Teams issue)

### Long-term (Requires Vexa Platform Update)
1. Monitor Vexa releases for avatar API availability
2. Monitor Vexa issue #124 for Teams video publishing resolution
3. Full Fathom parity achievable only after both above are resolved

## Technical References

**Vexa API Documentation:**
- Main API: https://docs.vexa.ai/api/bots
- Interactive bots status: https://docs.vexa.ai/api/interactive-bots
- GitHub repository: https://github.com/Vexa-ai/vexa

**Key Vexa Issues:**
- #124: Teams admitted bot never publishes avatar video
- Avatar API tracked in interactive-bots roadmap

**Code Locations:**
- Bot name generation: `packages/domain/src/bot-name.ts`
- Vexa client: `packages/meeting-bots/src/vexa/client.ts`
- Bot creation flow: `packages/domain/src/meeting-bots.ts` (line 386)
- API types: `packages/meeting-bots/src/types.ts`

## Summary for Stakeholders

**What works today:**
- Branded bot name: "AW Echo · {FirstName}" visible in Teams participant list

**What requires Vexa platform support:**
- Profile picture/avatar: API exists but returns 404
- Video tile with logo: Blocked by both Vexa API availability + Teams platform issue

**Trust/branding gap vs Fathom:**
- Fathom shows logo tile in meeting → **Echo shows initials circle**
- Workaround: None at application level (platform limitation)
- ETA for full parity: Dependent on Vexa 0.12.x roadmap + Teams fix

**Risk assessment:**
- Zero production risk (no behavior changes)
- Infrastructure ready for quick activation when Vexa enables avatar API
- Teams video tile may require longer timeline (separate platform issue)
