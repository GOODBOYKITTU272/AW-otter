# Trusted Teams Bot Identity Spike (Track D)

**Spike deliverable for AW-otter lobby investigation.**  
**Status**: Options analysis only — no implementation, no fake code.

## Current State: Anonymous Guest Join

**How Vexa joins today** (`packages/meeting-bots/src/vexa/client.ts`):
- POST `/bots` with `meeting_url` only (no credentials, no Microsoft identity)
- Bot joins as **anonymous guest** via the Teams join URL
- No signed-in Microsoft account, no tenant relationship
- Standard Teams behavior: **always lands in lobby** unless tenant/meeting policy explicitly bypasses anonymous guests

**Why this matters:**
- Anonymous guests wait for manual admission (human must click "Admit")
- Track A (tenant policy: AutoAdmittedUsers=Everyone) and Track B′ (meeting-level lobby bypass PATCH) are **defense-in-depth** but do not eliminate lobby risk
- For client-hosted meetings (their tenant, their policy), ApplyWizz has no control — manual admission is the only guarantee

## Options for Trusted Bot Identity

### Option 1: Resource Account (Licensed User Join)

**What it is:**
- Provision a **licensed Microsoft 365 user** in ApplyWizz's tenant (e.g. `echo-bot@applywizz.com`)
- Vexa (or Echo directly) joins as this signed-in user instead of anonymous guest
- **Requires Vexa API support** for authenticated join (username + password or app token)

**Benefits:**
- Trusted identity: appears as "real" tenant user, not anonymous guest
- May bypass lobby if tenant policy admits "organization" or "invited" attendees
- Still works for client-hosted meetings if bot user is explicitly invited as attendee

**Costs / Complexity:**
- **Microsoft 365 license cost**: ~$6–12/month per user (Business Basic or equivalent)
- **Vexa limitation**: Current Vexa API does NOT support authenticated join — would require Vexa to add this feature or Echo to switch bot providers
- **Credential management**: Storing bot account credentials securely (rotate passwords, handle MFA exemptions)
- **Invitation workflow**: For client meetings, bot user must be added as calendar attendee (CRM/scheduler integration change)
- **Phase estimate**: 2–3 sprints (negotiate Vexa feature, credential plumbing, CRM integration, test client meetings)

### Option 2: App Hosted Media (Native Teams Bot)

**What it is:**
- Build a **native Microsoft Teams application** registered in ApplyWizz's tenant
- Use [Application Hosted Media](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/registering-calling-bot) to handle real-time audio/video streams directly
- Bot is a first-class Teams app, not a third-party service like Vexa

**Benefits:**
- **Automatic admission**: Native bots can auto-join meetings when invited (no lobby)
- Full control over recording/transcription pipeline
- No per-meeting cost (no Vexa API usage)
- Trusted by Teams platform (installed app, not anonymous guest)

**Costs / Complexity:**
- **Major architectural change**: Replace Vexa entirely; Echo becomes the bot runtime
- **Infrastructure**: Real-time media servers, audio/video codec handling (WebRTC, Opus, H.264)
- **Graph API complexity**: Manage bot lifecycle via [Cloud Communications API](https://learn.microsoft.com/en-us/graph/api/resources/communications-api-overview)
- **Client tenant installation**: Each client must **install the ApplyWizz Echo bot app** into their Teams tenant (admin consent + app catalog) — heavy lift for every new client
- **Compliance/recording**: Recording consent, storage, GDPR/compliance built from scratch (Vexa handles this today)
- **Phase estimate**: 6–12 months (Phase-2 strategic initiative, not tactical lobby fix)

### Option 3: Compliance Recording (Policy-Based)

**What it is:**
- Register Echo as a [Compliance Recording bot](https://learn.microsoft.com/en-us/microsoftteams/teams-recording-policy) via Teams Admin Center
- Tenant admin enables "Compliance Recording" policy for specific users/meetings
- Bot auto-joins without lobby when compliance policy triggers

**Benefits:**
- **Automatic admission**: No lobby when policy is active
- Designed for enterprise compliance/legal hold scenarios (strong trust model)
- No per-meeting invitation needed

**Costs / Complexity:**
- **Tenant admin action required**: Each client/org must configure compliance recording policy in their Teams Admin Center — **ApplyWizz cannot do this remotely**
- **Client trust barrier**: "Compliance Recording" label may raise legal/privacy concerns (clients may resist)
- **Vexa limitation**: Vexa is NOT a registered compliance bot — would require switching to a compliant bot provider or building native (see Option 2)
- **Phase estimate**: 3–6 months (negotiate client admin actions, switch bot provider, test compliance flows)

### Option 4: Stay with Anonymous Guest + Manual Admission (Current State)

**What it is:**
- Keep Vexa anonymous guest join as-is
- Apply Track A (tenant policy) + Track B′ (meeting-level lobby bypass PATCH) as defense-in-depth
- Accept manual admission as operational reality for most meetings

**Benefits:**
- **Zero engineering cost**: Already implemented and stable
- **No client coordination**: Works for any Teams meeting (no tenant installation, no admin actions)
- **No Vexa dependency**: No need to negotiate new features or switch providers
- **Dispatch timing fix**: `bot_dispatch_lead_seconds=90s` minimizes admission window (bot arrives just before meeting starts)

**Costs / Complexity:**
- **Manual admission still required**: Human must click "Admit" (especially for client-hosted meetings)
- **Risk of missed recordings**: If no one admits the bot, recording fails
- **Lobby wait time**: 90s default (configurable per org)

**Recommendation**: This is the **default safe state** until product/owner decides lobby friction is a blocker.

## Phase-1 vs Phase-2 Recommendation

### Phase-1 (Tactical, Low Lift)
**Track B′ (implemented in this PR) + Track A (tenant policy)**
- Enable `ENABLE_LOBBY_BYPASS_PATCH=true` after tenant admin grants `OnlineMeetings.ReadWrite.All`
- Apply tenant-level Global AutoAdmittedUsers=Everyone policy (Track A) if not already done
- Keep Vexa anonymous guest join (Option 4)
- **Cost**: 1 sprint (already done), $0/month
- **Risk**: Lobby friction remains for client-hosted meetings (their tenant policy controls)

### Phase-2 (Strategic, High Lift)
**Licensed Resource Account (Option 1) or Native App Hosted Media (Option 2)**
- **Option 1 (Resource Account)**: If Vexa adds authenticated join support, provision bot user + negotiate client invitation workflow
  - **Cost**: 2–3 sprints, ~$10/month license, moderate risk (Vexa feature dependency)
  - **Benefit**: Likely bypasses lobby for invited attendees, works with existing Vexa provider
- **Option 2 (App Hosted Media)**: Build native Teams bot app from scratch
  - **Cost**: 6–12 months, significant infra/compliance investment, high risk (client installation barrier)
  - **Benefit**: Full control, zero lobby friction (when app is installed), no Vexa dependency

**Recommendation**: 
1. **Immediate (Phase-1)**: Ship Track B′ (this PR) + Track A tenant policy. Monitor lobby admission success rate.
2. **Evaluate after 1–2 months**: If lobby friction is a real blocker (>10% missed recordings or client complaints), explore **Option 1 (Resource Account)** as Phase-2 tactical fix.
3. **Long-term (Phase-3+)**: If Echo scales to 100+ clients and lobby remains a pain point, consider **Option 2 (Native App)** as strategic platform investment.

## Exact Next Engineering Steps (If Owner Greenlights Phase-2)

### If Option 1 (Resource Account) is chosen:
1. **Negotiate with Vexa**: Confirm whether Vexa API can support authenticated join (username/password or OAuth token). If NO → pivot to Option 2 or stay with Option 4.
2. **Provision bot user**: Create `echo-bot@applywizz.com` in ApplyWizz's Microsoft 365 tenant, assign Business Basic license.
3. **Credential plumbing**: Store bot credentials in Secrets Manager (same pattern as `MICROSOFT_CLIENT_SECRET`), handle MFA exemption if required.
4. **Update Vexa adapter**: Modify `packages/meeting-bots/src/vexa/client.ts` to pass bot credentials if available (fallback to anonymous join if not).
5. **CRM integration**: For client meetings, ensure bot user is added as calendar attendee (may require scheduler/CRM API changes).
6. **Test matrix**: Verify admission behavior for (a) ApplyWizz-hosted meetings, (b) client-hosted meetings with bot invited, (c) client-hosted meetings without bot invited (fallback to anonymous).
7. **Docs**: Update `teams-bot-admission-policy.md` with resource account setup + invitation workflow.

### If Option 2 (App Hosted Media) is chosen:
1. **Architecture spike**: Design real-time media server stack (Azure Media Services, WebRTC signaling, codec handling).
2. **Bot registration**: Register native Teams bot in ApplyWizz's tenant via Azure Portal (Bot Framework + App Hosted Media capabilities).
3. **Graph API integration**: Implement [Call Records API](https://learn.microsoft.com/en-us/graph/api/resources/callrecords-api-overview) + [Cloud Communications](https://learn.microsoft.com/en-us/graph/api/resources/communications-api-overview).
4. **Recording pipeline**: Build audio/video capture, storage (replace Vexa's S3 delivery with direct Graph recording or custom storage).
5. **Compliance/consent**: Implement recording consent banners, GDPR data handling, retention policies (currently Vexa's responsibility).
6. **Client installation flow**: Build tenant admin onboarding (app catalog submission, admin consent screens).
7. **Docs**: Write multi-page ops/setup guide for client tenant installation.

**Timeline**: Option 1 = 2–3 sprints. Option 2 = 6–12 months.

## Stub Interface for Future Authenticated Join (Optional)

**Location**: `packages/meeting-bots/src/types.ts`

```typescript
/**
 * Future: Authenticated bot join credentials (Track D, Phase-2).
 * NOT IMPLEMENTED — stub interface only for spike deliverable.
 * 
 * When Vexa API (or native Teams bot) supports authenticated join:
 * - `username`: Bot user UPN (e.g. echo-bot@applywizz.com)
 * - `password`: Bot user password (or OAuth token)
 * - `authType`: "basic" (username/password) or "oauth" (token-based)
 * 
 * If present, MeetingBotProvider.createBot() uses authenticated join.
 * If absent, falls back to anonymous guest join (current behavior).
 */
export interface BotAuthCredentials {
  username: string;
  password: string;
  authType: "basic" | "oauth";
}

export interface CreateBotInput {
  meetingUrl: string;
  idempotencyKey: string;
  botName: string;
  botAvatarUrl?: string;
  
  /**
   * Optional: Authenticated join credentials (Track D, Phase-2).
   * NOT USED TODAY — Vexa joins as anonymous guest.
   */
  authCredentials?: BotAuthCredentials;
}
```

**Do NOT implement**: This is a sketch interface only. No fake auth plumbing, no Vexa API changes, no credential storage. Stub exists solely to document Phase-2 contract if owner approves Option 1.
