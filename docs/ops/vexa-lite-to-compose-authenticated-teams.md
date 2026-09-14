# Vexa-lite → Compose Authenticated Teams: Migration Runbook

**Status:** Planning only — do not execute VM changes without owner approval  
**Created:** 2026-09-14  
**Target:** Migrate `vexa-lite:v012` on `40.80.81.54` to Compose/Helm authenticated join

---

## Current State

### Existing Deployment: `vexa-lite:v012` on `40.80.81.54`

- **Image:** `vexa/vexa-lite:v012` (anonymous guest bot, no authentication)
- **Join Mode:** Anonymous guest (no Microsoft identity)
- **Admission:** Relies on tenant lobby policy or manual admission
- **Limitations:** Cannot join authenticated Teams meetings, lands in lobby by default
- **Audio/Recording:** Functional (Vexa audio pipeline works in anonymous mode)
- **Webhooks:** Vexa status webhooks to AW-otter API (`/api/webhooks/vexa`)

### Why Migrate?

The anonymous guest bot (vexa-lite) cannot:
- Bypass lobby for invited attendees (even when tenant policy admits "invited")
- Join meetings with authenticated-only admission policies
- Access Graph-authenticated features (e.g., native cloud recordings via Graph API)

**Goal:** Enable authenticated join as `Echo@Applywizz.ai` (or `Echo@applywizz.ai`) using Vexa Compose with userdata authentication.

---

## Target Architecture: Compose/Helm Authenticated

### Compose Configuration

Use the **same v012 line** (no version upgrade, minimize risk):
- **Base Image:** `vexa/compose:v012` (NOT vexa-lite)
- **Authentication Mode:** Userdata-based (MinIO/S3 + BOT_AUTHENTICATED=true)
- **Login Step:** `make login AUTH_PLATFORM=teams` as Echo@

### Key Changes

1. **Switch from vexa-lite to compose:**
   - vexa-lite = anonymous guest only
   - compose = supports both anonymous + authenticated modes

2. **Enable userdata authentication:**
   - Store Teams credentials (Echo@Applywizz.ai or Echo@applywizz.ai) in MinIO or S3
   - Set `BOT_AUTHENTICATED=true` in environment
   - Run `make login AUTH_PLATFORM=teams` during pod init to authenticate as Echo@

3. **Preserve existing integrations:**
   - Audio recording pipeline (Vexa → AW-otter API)
   - Status webhooks (Vexa → `/api/webhooks/vexa`)
   - Bot avatar, display name, and branding

---

## Migration Steps (DO NOT EXECUTE WITHOUT APPROVAL)

### 1. Verify Echo@ Mailbox UPN in Entra ID

**CRITICAL:** Verify exact casing of Echo's User Principal Name in Azure Entra ID.

```bash
# Option A: Azure CLI (if authenticated)
az ad user show --id Echo@Applywizz.ai --query userPrincipalName -o tsv

# Option B: Graph API
curl -H "Authorization: Bearer $GRAPH_TOKEN" \
  'https://graph.microsoft.com/v1.0/users/Echo@Applywizz.ai' | jq -r .userPrincipalName
```

Expected: `Echo@Applywizz.ai` or `Echo@applywizz.ai`  
**Use the real mailbox UPN in all subsequent steps.**

### 2. Store Echo@ Credentials in MinIO/S3

Vexa Compose authenticates using credentials stored in userdata (MinIO or S3).

**MinIO Setup (if using self-hosted MinIO):**
```bash
# Store credentials in MinIO bucket
mc alias set myminio https://minio.applywizz.internal $ACCESS_KEY $SECRET_KEY
mc mb myminio/vexa-userdata
echo '{
  "email": "Echo@Applywizz.ai",
  "password": "<ECHO_PASSWORD>"
}' | mc pipe myminio/vexa-userdata/echo-teams-creds.json
```

**S3 Setup (if using AWS S3):**
```bash
# Store credentials in S3 bucket
aws s3 mb s3://vexa-userdata
echo '{
  "email": "Echo@Applywizz.ai",
  "password": "<ECHO_PASSWORD>"
}' | aws s3 cp - s3://vexa-userdata/echo-teams-creds.json
```

**Security:**
- Store credentials encrypted at rest (MinIO/S3 server-side encryption)
- Restrict bucket access to Vexa pods only (IAM policy / MinIO policy)
- Rotate Echo@ password periodically (update userdata file after rotation)

### 3. Update Helm Chart / Kubernetes Deployment

**Example: Helm values.yaml update**

```yaml
image:
  repository: vexa/compose
  tag: v012  # Same v012 line, not vexa-lite

env:
  - name: BOT_AUTHENTICATED
    value: "true"
  - name: USERDATA_SOURCE
    value: "s3://vexa-userdata/echo-teams-creds.json"  # or MinIO equivalent
  - name: AUTH_PLATFORM
    value: "teams"
  - name: WEBHOOK_URL
    value: "https://echo.applywizz.ai/api/webhooks/vexa"  # Preserve existing webhook
  - name: BOT_AVATAR_URL
    value: "https://echo.applywizz.ai/bot-avatar.png"  # Preserve branding

# Preserve audio/recording webhook configuration
webhooks:
  enabled: true
  statusEndpoint: "https://echo.applywizz.ai/api/webhooks/vexa"
  recordingEndpoint: "https://echo.applywizz.ai/api/internal/audio-recordings/ingest"

# Add init container to authenticate before bot joins
initContainers:
  - name: teams-login
    image: vexa/compose:v012
    command: ["make", "login"]
    env:
      - name: AUTH_PLATFORM
        value: "teams"
      - name: USERDATA_SOURCE
        value: "s3://vexa-userdata/echo-teams-creds.json"
```

**Apply the updated deployment:**
```bash
helm upgrade vexa-bot ./vexa-helm-chart -f values.yaml --namespace vexa --wait
```

### 4. Verify Authenticated Join

**Test authenticated join:**
1. Schedule a test Teams meeting as an Apply Wizz user
2. Set meeting admission policy: "Only invited people" (not "Everyone")
3. Dispatch Vexa bot via AW-otter API
4. Verify bot joins WITHOUT landing in lobby
5. Verify audio recording completes successfully

**Expected outcome:**
- Bot joins as `Echo@Applywizz.ai` (authenticated identity, not anonymous guest)
- No lobby wait (assuming Echo is invited or tenant policy admits authenticated users)
- Audio recording webhook fires successfully
- Recording artifact appears in MinIO/S3 and ingests to AW-otter

**Failure modes:**
- Bot lands in lobby → MFA prompt or credentials invalid (see Risks below)
- Bot fails to join → Network issue, credentials expired, or Vexa v012 bug
- No audio recording → Webhook URL misconfigured or recording pipeline broken

### 5. Preserve Audio/Recording/Webhooks Checklist

Verify the following **before and after migration:**

- [ ] Audio recording webhook URL: `https://echo.applywizz.ai/api/internal/audio-recordings/ingest`
- [ ] Status webhook URL: `https://echo.applywizz.ai/api/webhooks/vexa`
- [ ] Bot avatar URL: `https://echo.applywizz.ai/bot-avatar.png`
- [ ] Bot display name generation (owner's name, e.g., "Ramakrishna's Echo")
- [ ] Vexa status polling (awaiting_admission, in_call_recording, completed)
- [ ] Operational incidents (lobby detection, customer missing alerts)
- [ ] Meeting lifecycle events (`meeting_lifecycle_events` table)

**Test:**
1. Join test meeting (authenticated mode)
2. Verify status webhook fires (`awaiting_admission`, `in_call_recording`, `completed`)
3. Verify audio recording webhook delivers recording artifact
4. Verify recording ingests to Supabase (`audio_recordings` table)
5. Verify transcription kicks off (if enabled)

---

## Risks and Mitigations

### Risk 1: MFA Prompt Blocks Automated Login

**Issue:** If Echo@Applywizz.ai has MFA enabled, `make login AUTH_PLATFORM=teams` may prompt for MFA token, blocking automated join.

**Mitigation:**
- **Option A (PREFERRED):** Disable MFA for Echo@ service account (IT admin action in Entra ID)
- **Option B:** Use Conditional Access Policy to exempt Echo@ from MFA when joining from known IPs (Vexa pod CIDR)
- **Option C:** Use app-only authentication (service principal) instead of user credentials (requires Vexa Compose to support app-only mode — verify with Vexa support)

**Test:** Run `make login AUTH_PLATFORM=teams` interactively on a test pod to verify no MFA prompt appears.

### Risk 2: One-Session Concurrency

**Issue:** Vexa Compose may enforce one active session per authenticated user. If Echo@ is already logged in elsewhere (e.g., desktop Teams), authenticated bot join may fail or disconnect the other session.

**Mitigation:**
- **Option A:** Ensure Echo@ is a **bot-only account** (no human logs in as Echo@)
- **Option B:** Test concurrent session behavior with Vexa support (can Echo@ join multiple meetings simultaneously?)
- **Option C:** Use multiple bot accounts (Echo1@, Echo2@, Echo3@) for concurrent meetings (requires separate credentials + mailboxes)

**Test:** Log in as Echo@ in desktop Teams, then dispatch Vexa bot as Echo@. Verify desktop session does NOT disconnect.

### Risk 3: Teams Validation Gap (Vexa v012)

**Issue:** Vexa v012 is a **guest-bot-focused release**. Authenticated join may be undertested or have edge-case bugs.

**Mitigation:**
- **Option A:** Test authenticated join on a staging environment first (NOT production `40.80.81.54`)
- **Option B:** Contact Vexa support to confirm v012 authenticated mode is production-ready
- **Option C:** Wait for Vexa v013+ if authenticated join is marked as "beta" or "experimental" in v012

**Test:** Run authenticated join on a **staging VM** for 1-2 weeks before production migration.

### Risk 4: No Cookie Hack

**EXPLICIT:** This migration does **NOT** use any cookie-based authentication hacks or undocumented APIs.

**Approved methods:**
- Vexa Compose userdata authentication (official Vexa feature)
- `make login AUTH_PLATFORM=teams` (documented in Vexa docs)
- MinIO/S3 credential storage (standard Vexa Compose pattern)

**Forbidden:**
- Manually extracting Teams session cookies from browser
- Reverse-engineering Teams authentication flow
- Injecting cookies into Vexa bot session (brittle, unsupported)

---

## Rollback Plan

If authenticated join fails or introduces regressions:

1. **Immediate rollback:**
   ```bash
   helm rollback vexa-bot --namespace vexa
   ```

2. **Restore vexa-lite:v012 anonymous guest mode:**
   ```yaml
   image:
     repository: vexa/vexa-lite
     tag: v012

   env:
     - name: BOT_AUTHENTICATED
       value: "false"  # Anonymous guest mode
   ```

3. **Verify anonymous guest bot still works:**
   - Dispatch test meeting
   - Verify bot lands in lobby (expected)
   - Manually admit bot
   - Verify audio recording completes

**Fallback strategy:** If authenticated join proves unreliable, revert to anonymous guest + Track A/B′ (lobby bypass PATCH + Echo attendee invite) for incremental improvement without Vexa migration.

---

## Success Criteria

This migration is successful when:

1. **Authenticated join works:** Bot joins as `Echo@Applywizz.ai` without landing in lobby (when invited or tenant policy permits)
2. **No MFA prompts:** `make login` completes automatically without human intervention
3. **Audio/recording preserved:** Webhooks fire, recordings ingest, transcription works
4. **No session conflicts:** Echo@ can join multiple meetings concurrently (or documented limitation accepted)
5. **Zero regression:** No loss of existing functionality (bot dispatch, lifecycle tracking, operational alerts)

---

## References

- **Vexa Compose Docs:** [https://docs.vexa.ai/compose/authentication](https://docs.vexa.ai/compose/authentication) (example URL, verify actual docs)
- **AW-otter Lobby Detection:** `docs/ops/p1-bot-reliability-improvements.md`
- **AW-otter Track A/B′:** This PR (Echo attendee invite + lobby bypass PATCH)
- **Microsoft Teams Admission Policy:** `docs/ops/teams-bot-admission-policy.md`

---

## Owner Review Required Before Execution

**DO NOT execute VM changes without:**
1. Owner approval of this runbook
2. Staging environment testing (1-2 weeks)
3. Verification that Echo@Applywizz.ai mailbox exists and is bot-only
4. Confirmation that OnlineMeetings.ReadWrite.All is granted (for Track A/B′ fallback)
5. MFA exemption or Conditional Access Policy for Echo@

**Contact:** ramakrishna@applywizz.ai for approval and Entra ID changes
