# No-Customer Policy

## Overview

When a meeting has both the AW Echo bot and an Account Manager present, but **no external customer attendee** actually joined, this represents a waste of bot resources and should be flagged and prevented.

## Policy Rules

### Detection Criteria

A violation occurs when **all** of the following are true:
1. Meeting is completed
2. At least one bot job completed successfully (bot was present)
3. The meeting owner (AM) was an attendee
4. Zero external customer attendees actually attended the meeting
   - External = email domain not matching any organization membership
   - Must have `attended: true` (not just invited)
   - Excludes the meeting organizer

### Violation Types

- **`no_customer_attendee`**: Bot + AM present, meeting has a linked customer, but no external customer actually attended
- **`customer_not_linked`**: Bot + AM present, but `meeting.customer_id` is null (meeting was never linked to a customer record)

## Notification Policy

### Account Manager (AM) Notification
- **Trigger**: Always, on every violation
- **Channel**: In-app notification (or existing notification path if one exists)
- **Message**: "Your meeting '{title}' had AW Echo present but no customer attended. Bot resources were used unnecessarily."

### Manager Notification
- **Trigger**: Only when repeat threshold is reached
- **Threshold**: `NO_CUSTOMER_REPEAT_THRESHOLD = 2` violations within `NO_CUSTOMER_LOOKBACK_DAYS = 7` days
- **Channel**: In-app notification or email to the AM's manager
- **Message**: "{AM Name} has had {count} meetings in the past {days} days where AW Echo joined but no customer attended."

## Intelligence Processing Block

When a no-customer violation is detected:
- Block Customer Truth / intelligence processing (same treatment as integrity FAIL)
- Do not create or process AI intelligence runs
- Meeting recaps cannot be approved
- This prevents bad/empty intelligence from polluting the customer record

## Implementation Notes

### Constants
```typescript
export const NO_CUSTOMER_REPEAT_THRESHOLD = 2;
export const NO_CUSTOMER_LOOKBACK_DAYS = 7;
```

### Evaluation Flow
1. Check if meeting is completed
2. Check if bot completed successfully
3. Analyze attendees to identify external vs internal
4. Determine violation type (if any)
5. Count recent violations for threshold logic
6. Return notification/blocking decision

### Integration Points
- Called during meeting intelligence processing (before running AI)
- Results logged to policy evaluation history for threshold tracking
- Notification system (if one exists) receives events for AM/manager alerts

## Future Enhancements

1. **Violation History Storage**: Store policy evaluation results in a `meeting_policy_violations` table for accurate threshold counting
2. **Configurable Thresholds**: Allow org admins to configure threshold and lookback window per their needs
3. **Automated Prevention**: Automatically cancel bot dispatch when a meeting has no customer attendees confirmed by a certain time before start
4. **Dashboard Reporting**: Show no-customer violation trends in manager dashboards
