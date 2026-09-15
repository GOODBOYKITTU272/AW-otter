# Track A: Echo Attendee Auto-Invite

**Status:** Implemented (feature-flagged, OFF by default)  
**Created:** 2026-09-14  
**Feature Flag:** `ENABLE_ECHO_ATTENDEE_INVITE=true`

---

## Overview

Track A automatically adds **Echo@Applywizz.ai** (or **Echo@applywizz.ai** — verify exact UPN casing in Entra ID) to the attendee list of Apply Wizz–organized Teams online meetings via Microsoft Graph API.

This ensures Echo is on the official meeting attendee list, which may improve lobby admission when tenant policies admit "invited" attendees.

---

## How It Works

1. **When:** Before bot dispatch (same timing as Track B′ lobby bypass)
2. **Where:** `packages/domain/src/echo-attendee.ts` (called from `meeting-bots.ts`)
3. **API:** `PATCH /users/{userOid}/onlineMeetings/{id}` with `participants.attendees`
4. **Idempotent:** Graph deduplicates attendees automatically (safe to call multiple times)
5. **Best-Effort:** Logs success/failure, never throws (bot dispatch proceeds regardless)

### Example Graph Call

```typescript
PATCH /users/{organizer-oid}/onlineMeetings/{meeting-id}
{
  "participants": {
    "attendees": [
      {
        "upn": "Echo@Applywizz.ai",
        "identity": {
          "user": {
            "id": "{echo-object-id}",
            "displayName": "Echo"
          }
        }
      }
    ]
  }
}
```

---

## Prerequisites

### 1. Microsoft Graph Permission

Requires **OnlineMeetings.ReadWrite.All** (Application permission, same as Track B′ lobby bypass).

**Grant consent:**
1. Log in to [Azure Portal](https://portal.azure.com) as tenant admin
2. Navigate to App Registrations → `applywizz-echo` app
3. API Permissions → Add permission → Microsoft Graph → Application permissions
4. Select `OnlineMeetings.ReadWrite.All`
5. Click "Grant admin consent"

### 2. Echo Mailbox in Entra ID

Verify Echo's mailbox exists and note the exact UPN casing:

```bash
# Azure CLI
az ad user show --id Echo@Applywizz.ai --query userPrincipalName -o tsv

# Graph API
curl -H "Authorization: Bearer $GRAPH_TOKEN" \
  'https://graph.microsoft.com/v1.0/users/Echo@Applywizz.ai' | jq -r .userPrincipalName
```

**Expected:** `Echo@Applywizz.ai` or `Echo@applywizz.ai`

### 3. Environment Variables

Set the following environment variables:

```bash
# Feature flag (required to enable)
ENABLE_ECHO_ATTENDEE_INVITE=true

# Echo's User Principal Name (optional, defaults to Echo@Applywizz.ai)
ECHO_UPN=Echo@Applywizz.ai

# Echo's Azure AD object ID (optional, improves API reliability)
ECHO_OBJECT_ID=8b294bc6-1234-5678-abcd-456789fedcba
```

**Note:** Use the **real mailbox UPN** from Entra ID, not guessed casing.

---

## Enable the Feature

### Production (Vercel)

1. Navigate to Vercel project settings → Environment Variables
2. Add `ENABLE_ECHO_ATTENDEE_INVITE=true`
3. Optionally add `ECHO_UPN` and `ECHO_OBJECT_ID`
4. Redeploy

### Local Development

```bash
# .env.local
ENABLE_ECHO_ATTENDEE_INVITE=true
ECHO_UPN=Echo@Applywizz.ai
ECHO_OBJECT_ID=8b294bc6-1234-5678-abcd-456789fedcba
```

---

## Audit Events

Track A logs audit events to `operational_audit_log` table:

### Success
```json
{
  "action": "meeting.echo_attendee_added",
  "entityType": "meeting",
  "entityId": "meeting-uuid",
  "metadata": {
    "onlineMeetingId": "graph-meeting-id",
    "userOid": "organizer-guid",
    "echoUpn": "Echo@Applywizz.ai"
  }
}
```

### Failure (Organizer GUID Not Found)
```json
{
  "action": "meeting.echo_attendee_skipped_no_guid",
  "entityType": "meeting",
  "entityId": "meeting-uuid",
  "metadata": {
    "reason": "Cannot resolve organizer to Azure AD GUID",
    "organizerEmail": "organizer@applywizz.ai"
  }
}
```

### Failure (Graph API Error)
```json
{
  "action": "meeting.echo_attendee_failed",
  "entityType": "meeting",
  "entityId": "meeting-uuid",
  "metadata": {
    "error": "Graph API permission denied",
    "onlineMeetingId": "graph-meeting-id"
  }
}
```

---

## Benefits

1. **Lobby Admission:** When tenant policy admits "invited" attendees, Echo may bypass lobby
2. **Audit Trail:** Echo appears on official attendee list (visible in Teams meeting details)
3. **Permissions:** May improve meeting access permissions for authenticated bots (future)
4. **Defense-in-Depth:** Complements Track B′ lobby bypass for maximum admission reliability

---

## Constraints

### Only for Apply Wizz–Organized Meetings

Track A only works when:
- Meeting has a `online_meeting_id` (Graph meeting ID)
- Organizer is an Apply Wizz employee (we can resolve their Azure AD GUID)
- CRM-synced meetings may lack these fields (bot relies on join URL only)

### No Effect on Customer-Hosted Meetings

Customer-hosted meetings use the **customer's tenant**, not Apply Wizz's. We have no Graph API access to modify their meetings. Track A is **no-op** for customer meetings.

### Idempotent, Not Retroactive

Adding Echo multiple times is safe (Graph deduplicates). However, Track A does NOT retroactively add Echo to existing meetings. It only applies to **new bot dispatches** after the feature is enabled.

---

## Testing

### Unit Tests

```bash
pnpm test packages/domain/src/echo-attendee.test.ts
pnpm test packages/microsoft/src/graph-client.test.ts
```

### Integration Test

1. Schedule a test Teams meeting as an Apply Wizz user
2. Enable `ENABLE_ECHO_ATTENDEE_INVITE=true`
3. Dispatch bot via AW-otter UI or API
4. Check `operational_audit_log` for `meeting.echo_attendee_added` event
5. Verify Echo appears in Teams meeting attendee list (Teams UI → Meeting details → Participants)

---

## Troubleshooting

### Echo not added to attendee list

**Check:**
1. Feature flag enabled: `ENABLE_ECHO_ATTENDEE_INVITE=true`
2. Graph permission granted: `OnlineMeetings.ReadWrite.All` (with admin consent)
3. Meeting has `online_meeting_id`: query `meetings` table, check `online_meeting_id IS NOT NULL`
4. Organizer is Apply Wizz employee: check `calendar_connections` table for organizer's email
5. Audit log: query `operational_audit_log` for `meeting.echo_attendee_*` events

### Graph API 403 Forbidden

**Issue:** Missing `OnlineMeetings.ReadWrite.All` permission or admin consent.

**Fix:** Grant admin consent in Azure Portal (see Prerequisites above).

### Graph API 404 Not Found

**Issue:** `online_meeting_id` is invalid or meeting was deleted.

**Fix:** Verify meeting still exists in Microsoft Graph:
```bash
curl -H "Authorization: Bearer $GRAPH_TOKEN" \
  "https://graph.microsoft.com/v1.0/users/$ORGANIZER_OID/onlineMeetings/$MEETING_ID"
```

### Echo@ UPN not found in Entra

**Issue:** `ECHO_UPN` environment variable does not match real mailbox UPN.

**Fix:** Query Entra ID to get exact UPN casing (see Prerequisites above).

---

## Future Enhancements

### Combine with Authenticated Join (Track B)

When Vexa Compose authenticated join is enabled (see `docs/ops/vexa-lite-to-compose-authenticated-teams.md`):
- Track A adds Echo@ as attendee (Graph API)
- Vexa bot joins as Echo@ (authenticated Teams session)
- Result: Bot is both invited AND authenticated → maximum lobby bypass reliability

### Add Other Attendees

Track A currently only adds Echo. Future: allow adding multiple attendees (e.g., AM's backup, recording admin) via `ADDITIONAL_ATTENDEES` env var.

---

## References

- **Implementation:** `packages/domain/src/echo-attendee.ts`
- **Tests:** `packages/domain/src/echo-attendee.test.ts`, `packages/microsoft/src/graph-client.test.ts`
- **Graph API Docs:** [Update onlineMeeting](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-update)
- **Track B′ (Lobby Bypass):** `packages/domain/src/lobby-bypass.ts`
- **Track B (Authenticated Join):** `docs/ops/vexa-lite-to-compose-authenticated-teams.md`
