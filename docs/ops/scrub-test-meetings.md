# Scrubbing Test Meetings

## Overview

The `meetings.is_test` flag soft-hides synthetic test/E2E data from production admin views while preserving all data for debugging and recovery. Real production meetings (e.g., "Rama krishna and Rudra Gautam") remain visible with `is_test = false`.

## Marking Test Meetings

### Identifying Test Meetings

Test meetings typically have patterns like:
- Titles containing "Test", "E2E", "Fake", "Demo", or similar markers
- Synthetic organizer names or emails
- Known test account identifiers

**Important**: Real meetings with names like "Rama krishna and Rudra Gautam" or other actual person names should **never** be marked as test data.

### SQL to Mark Test Meetings

Use the Supabase SQL Editor or `psql` with appropriate patterns:

```sql
-- Example: Mark meetings with "test" in the title (case-insensitive)
UPDATE public.meetings
SET is_test = true
WHERE LOWER(title) ILIKE '%test%'
  AND is_test = false;

-- Example: Mark meetings with "E2E" in the title
UPDATE public.meetings
SET is_test = true
WHERE title ILIKE '%E2E%'
  AND is_test = false;

-- Example: Mark meetings from a known test organizer email
UPDATE public.meetings
SET is_test = true
WHERE organizer_email = 'test@example.com'
  AND is_test = false;

-- Check before updating: preview what would be marked
SELECT id, title, organizer_name, organizer_email, scheduled_start
FROM public.meetings
WHERE LOWER(title) ILIKE '%test%'
  AND is_test = false
ORDER BY scheduled_start DESC
LIMIT 50;
```

### Verification

After marking test meetings, verify the admin view shows only real meetings:

1. Navigate to `/admin/meetings`
2. Confirm test meetings are no longer visible
3. Confirm real production meetings (like "Rama krishna and Rudra Gautam") remain visible

### Restoration

To restore accidentally hidden meetings:

```sql
-- Restore a specific meeting by ID
UPDATE public.meetings
SET is_test = false
WHERE id = '<meeting-uuid>';

-- Restore meetings matching a pattern
UPDATE public.meetings
SET is_test = false
WHERE title ILIKE '%Rama krishna%'
  AND is_test = true;
```

## Hard Deletion (Optional)

After confirming test data is correctly marked and no longer needed:

```sql
-- Hard delete test meetings (IRREVERSIBLE)
-- Only run after confirming is_test is correctly set
DELETE FROM public.meetings
WHERE is_test = true
  AND scheduled_start < NOW() - INTERVAL '90 days';
```

**Warning**: Hard deletion is permanent. The soft-hide approach with `is_test = true` is preferred for operational safety.

## Affected Views

The following pages filter out `is_test = true` meetings:
- Admin Recent Meetings (`/admin/meetings`)
- Manager Team Meetings (`/manager/meetings`)
- Upcoming Meetings component (used on home and manager pages)

Individual meeting detail pages and other admin tools may still show test meetings by ID for debugging purposes.
