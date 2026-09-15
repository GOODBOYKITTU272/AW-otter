# Teams Meeting Bot Admission Policy (M17C + Track B′)

Process/policy note only — no code, no bot-whitelisting, no native Teams bot. Grounded in what M17C's real tests actually showed tonight, not assumption.

## What we confirmed for real

Every real Vexa bot join tonight (multiple controlled Teams meetings) required a human to manually admit the bot from the lobby — it never bypassed the lobby on its own. Checked directly against Microsoft's own documentation ([anonymous-users-in-meetings](https://learn.microsoft.com/en-us/microsoftteams/anonymous-users-in-meetings), [Q&A on "Unverified"](https://learn.microsoft.com/en-us/answers/questions/5746541/what-does-it-mean-when-someone-joins-a-meeting-and)): this is standard Teams behavior for **any** participant without a signed-in, trusted Microsoft identity — not a Vexa-specific or ApplyWizz-specific limitation, and not something our code controls. Also confirmed directly against Vexa's own docs: the bot only ever joins as an anonymous guest via the meeting link — there is no credential/sign-in mechanism to present a trusted identity instead (see `docs/product/m17c-plan.md` and tonight's session record for the exact verification).

## The two real scenarios

**Meetings hosted by ApplyWizz's own Microsoft tenant.** ApplyWizz's tenant admin can configure Teams meeting policy (lobby bypass settings, allowed/blocked apps, guest/external access rules) to admit the AW Echo bot more smoothly **for meetings ApplyWizz itself hosts** — wherever Microsoft's own policy surface actually permits that for an anonymous/guest-style participant. This is a tenant-admin configuration action outside this codebase, not something to build.

**Meetings hosted by a client or university's own tenant.** ApplyWizz has no administrative control over a client's Teams/Microsoft 365 tenant. For any meeting the client organizes (their tenant, their lobby policy), assume the bot will land in the lobby and require the organizer (the client, or whichever ApplyWizz AM is a co-organizer) to manually admit it — exactly like every real test tonight. **Do not assume ApplyWizz's own tenant policy has any effect on a meeting hosted elsewhere** — Teams lobby/admission policy is enforced by whichever tenant owns the meeting, not the tenant the bot's link happens to point through.

## Track B′: Lobby Bypass PATCH (Defense-in-Depth)

**Production Readiness Implementation** (implemented in p3-production-readiness branch):

When Echo has an `online_meeting_id` for an Apply Wizz–organized meeting, the system can PATCH the Graph online meeting to set `lobbyBypassSettings.scope="everyone"` before bot join. This is a **defense-in-depth** measure: tenant-level policy (Track A) still matters, and this meeting-level override may help anonymous guest bots bypass the lobby more reliably.

### Feature Flag

- **Flag name**: `ENABLE_LOBBY_BYPASS_PATCH`
- **Default**: `false` (safe, requires explicit opt-in)
- **Set to `true`** only after tenant admin grants the required Graph permission

### Required Graph Permission

- **Application permission**: `OnlineMeetings.ReadWrite.All`
- **Scope**: App-only (tenant-wide access)
- **Admin consent required**: Yes (tenant admin must grant in Azure Portal)

This permission allows Echo to PATCH any online meeting organized by a user with an active calendar connection. It does NOT create meetings (CRM/scheduler supplies join URLs).

### Implementation Details

- **Where**: `packages/domain/src/lobby-bypass.ts` + wired into `processPendingBotJobs`
- **When**: Just before calling `provider.createBot()`, if meeting has `online_meeting_id` and `organizer_email`
- **Idempotent**: Safe to call multiple times; Graph PATCH is idempotent
- **Best-effort**: If PATCH fails (permission denied, meeting not found, organizer GUID unresolved), bot join still proceeds — logged as audit event but never throws
- **Audit events**: `meeting.lobby_bypass_applied`, `meeting.lobby_bypass_failed`, `meeting.lobby_bypass_skipped_no_guid`

### Organizer Resolution

Same pattern as Path C (video recording ingest): resolve organizer email to Azure AD GUID via `calendar_connections.provider_user_id`. The Graph API requires GUID, not UPN/email.

### Hypothesis

Meeting-level `lobbyBypassSettings` may help even when tenant-level Track A (Global AutoAdmittedUsers=Everyone) is already applied. This is defense-in-depth, not a replacement for tenant policy.

## What this means operationally, today

- No code change follows from this — the bot already correctly waits in the lobby and gets admitted by a human, which is the only thing that reliably work across both scenarios.
- The dispatch-timing fix (`bot_dispatch_lead_seconds`, default 90s) already minimizes how long anyone has to remember to admit it.
- **Track B′ (optional)**: If tenant admin grants `OnlineMeetings.ReadWrite.All`, set `ENABLE_LOBBY_BYPASS_PATCH=true` to enable meeting-level lobby bypass PATCH for Apply Wizz–organized meetings. This is best-effort and does not replace tenant-level policy (Track A).
- If ApplyWizz's own tenant policy is later configured to reduce lobby friction for ApplyWizz-hosted meetings specifically, that's a tenant-admin action to track separately — it does not change anything for client-hosted meetings, and does not require touching `MeetingBotProvider`, the Vexa adapter, or any bot logic.
- Not building: bot whitelisting, a native Teams application/bot registration, or any code-level workaround. Confirmed tonight (see the earlier feasibility spike) that removing the lobby step for guest-style bots would require a fundamentally different integration (a registered, tenant-installed Teams app) — out of scope here, and out of scope for every client-hosted meeting regardless, since ApplyWizz can't install anything into a client's tenant.
