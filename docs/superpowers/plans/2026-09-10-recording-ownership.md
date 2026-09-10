# Recording Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist one immutable ApplyWizz-owned audio recording per meeting in private Supabase Storage, make transcription consume our owned copy instead of Vexa after ingestion, and provide authorized short-lived playback access.

**Architecture:** Hosted Vexa remains the upstream recording source. The existing transcription worker calls `ensureOwnedRecording()` before transcription. The original audio is stored at a deterministic private Supabase Storage path and described by one `meeting_recordings` row. Once safely owned, all transcription retries and playback use our stored object rather than contacting Vexa again.

**Tech Stack:** TypeScript, Next.js, Supabase PostgreSQL, Supabase Storage (`@supabase/storage-js@2.115.0`, confirmed installed), existing durable transcription worker, hosted Vexa, OpenRouter transcription.

**Spec:** `docs/superpowers/specs/2026-09-10-recording-ownership-design.md`

## Global Constraints

- AUDIO ONLY.
- Exactly one owned original recording per meeting in P2.
- `UNIQUE (organization_id, meeting_id)`.
- Private Supabase Storage bucket (`meeting-recordings`).
- Deterministic object path: `organizations/{organization_id}/meetings/{meeting_id}/original.webm`.
- No permanent/public recording URL.
- No overwrite of an existing original recording.
- No automatic deletion.
- No new recording worker/queue — the existing `meeting_transcripts` retry/backoff is the only retry mechanism.
- Provider-specific metadata stays inside `source_metadata jsonb`, never leaks into top-level columns or normal AM UI.
- Vexa must not be contacted again once a recording is owned.
- Customer Truth behavior untouched.
- `MeetingBotProvider` untouched.
- No P3 multilingual work, no P4 dashboard work, no video, no FFmpeg video pipeline, no native Teams bot, no self-hosted Vexa, no DigitalOcean, no M17D.
- No `status`/`retry_count`/`claim_token` columns on `meeting_recordings` — a row's existence is the state (per approved spec §5).

---

## Phase 0 — Verified repository state (read-only, confirmed before writing this plan)

- Branch: `m17c-hosted-vexa-plan`. `git status`: clean. HEAD: `4e7270fb310004d5b331d851c7cc7ed3cfe62908`. 3 commits ahead of `origin/main` (`de3dee6`).
- `meeting_transcripts` RLS is exactly one policy: `meeting_transcripts_select_meeting_visible` — `EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_transcripts.meeting_id)`. Confirmed live against the running local database, not assumed.
- `packages/database/src/server.ts` exports `createSupabaseServiceRoleClient(url, serviceRoleKey)` — a plain `@supabase/supabase-js` `createClient<Database>()`. This client already exposes `.storage` — **no new Storage client wrapper is needed anywhere in this plan.**
- `@supabase/storage-js@2.115.0` is the installed version (confirmed via `node_modules/.pnpm`). Real, verified method signatures used throughout this plan:
  - `upload(path, body, {contentType, upsert}): Promise<{data:{id,path,fullPath}, error:null} | {data:null, error:StorageError}>`
  - `download(path): Promise<{data:Blob, error:null} | {data:null, error:StorageError}>`
  - `info(path): Promise<{data:{size, contentType, ...}, error:null} | {data:null, error:StorageError}>` — the cheap existence+metadata check (no download), confirmed to exist in this exact installed version, not assumed.
  - `createSignedUrl(path, expiresIn): Promise<{data:{signedUrl}, error:null} | {data:null, error:StorageError}>`
- Supabase Storage bucket creation has **zero existing precedent** in this repo — `supabase/config.toml`'s `[storage.buckets.*]` section is present only as a commented-out example. Buckets will be created via a migration (`insert into storage.buckets`), the one mechanism that behaves identically across local and any real deployed Supabase project — `config.toml` only affects the local CLI.
- pgTAP test convention confirmed from `supabase/tests/database/020_manager_customer_visibility.test.sql`: numbered files (`023_...` is next, following `022_operational_incidents_dedup_and_bump.test.sql`), `pg_temp.tests_as(p_user_id uuid)` helper function per file for identity-switching (`set_config('request.jwt.claim.sub', ...)` + `set_config('role','authenticated', true)`), real `auth.users` + `organization_memberships` fixture rows with fixed test UUIDs, `reset role` between checks.
- Domain package export convention confirmed from `packages/domain/package.json`: one `"./module-name": "./src/module-name.ts"` entry per module — `meeting-recordings` needs a new entry.
- Migration naming: `YYYYMMDDHHMMSS_description.sql`, latest existing is `20260912170001_bot_dispatch_lead_seconds.sql`. This plan's migration: `20260912180001_meeting_recordings.sql`.
- `processTranscriptionJob` (`packages/domain/src/transcription.ts`) current real shape (verified by reading the file in full tonight): fetches `meeting_bot_jobs` row (needs `provider_metadata` for the numeric Vexa id), calls `getMeetingRecordingRef` then `downloadRecordingMedia` (both in `packages/meeting-bots/src/vexa/recordings.ts`), writes to a `mkdtemp` work dir, transcodes, probes, transcribes, normalizes, calls `complete_transcription_job` RPC, deletes the work dir in `finally`. This plan's Task 7 inserts `ensureOwnedRecording` between the `botJob` fetch and the raw-bytes-write step, and nothing after that point changes.

No contradiction between the repository and the approved spec was found. Proceeding.

---

## File Map

| File | Action |
|---|---|
| `supabase/migrations/20260912180001_meeting_recordings.sql` | CREATE |
| `supabase/tests/database/023_meeting_recordings_rls.test.sql` | CREATE |
| `packages/domain/src/meeting-recordings.ts` | CREATE |
| `packages/domain/src/meeting-recordings.test.ts` | CREATE |
| `packages/domain/package.json` | MODIFY (add export) |
| `packages/database/src/types.ts` | MODIFY (regenerate for new table) |
| `packages/domain/src/transcription.ts` | MODIFY |
| `packages/domain/src/transcription.test.ts` | MODIFY |
| `apps/web/app/api/meetings/[id]/recording-url/route.ts` | CREATE |

No `route.test.ts` for the new API route — confirmed the existing convention (`apps/web/app/api/meeting-policy/set/route.ts`) has no dedicated test file in this codebase; route logic is thin and the underlying authorization is exercised by the pgTAP RLS tests (Task 1) plus a human test (Task 9).

No changes to `MeetingBotProvider`, `packages/meeting-bots/src/vexa/*`, Meeting Detail UI, or any P3/P4 area.

---

## Task 1 — Database schema, storage bucket, RLS

**Files:**
- Create: `supabase/migrations/20260912180001_meeting_recordings.sql`
- Create: `supabase/tests/database/023_meeting_recordings_rls.test.sql`

**Interfaces:**
- Produces: table `public.meeting_recordings` with columns exactly as in spec §5; Storage bucket `meeting-recordings` (private).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260912180001_meeting_recordings.sql

-- P2: Signal's first owned object-storage subsystem. Full design at
-- docs/superpowers/specs/2026-09-10-recording-ownership-design.md.
-- No status/retry_count/claim_token — a row's existence IS the state;
-- retry ownership stays entirely with meeting_transcripts (see spec §5
-- for why this is a deliberate simplification, not an oversight).

create table public.meeting_recordings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  meeting_id uuid not null references public.meetings (id) on delete cascade,

  storage_bucket text not null,
  storage_path text not null,

  content_type text not null,
  byte_size bigint not null check (byte_size > 0),
  duration_seconds numeric,
  checksum_sha256 text,

  source_provider text not null,
  source_metadata jsonb not null default '{}'::jsonb,

  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (organization_id, meeting_id)
);

create trigger meeting_recordings_set_updated_at
  before update on public.meeting_recordings
  for each row execute function set_updated_at();

alter table public.meeting_recordings enable row level security;

-- Mirrors meeting_transcripts_select_meeting_visible exactly (confirmed
-- against the live schema during planning) — the real authorization
-- decision (org scope, manager scope, role) is made transitively by
-- meetings' own existing RLS policies inside this EXISTS, not
-- duplicated here.
create policy meeting_recordings_select_meeting_visible
  on public.meeting_recordings
  for select
  to authenticated
  using (
    exists (
      select 1 from public.meetings m
      where m.id = meeting_recordings.meeting_id
    )
  );

-- No insert/update/delete policies for `authenticated` — every write to
-- this table happens via the service-role client from the transcription
-- worker, which bypasses RLS entirely, matching every other
-- worker-owned table in this codebase (meeting_bot_jobs, meeting_transcripts).

-- Private bucket — no public flag, no public read. All legitimate reads
-- go through the signed-URL route (Task 9), which authorizes via this
-- table's own RLS before ever touching Storage. No storage.objects RLS
-- policies are added: every Storage operation in this design (upload,
-- info, download, createSignedUrl) is performed by the service-role
-- client, which bypasses Storage RLS the same way it bypasses table RLS
-- — adding object-level policies here would be dead code, not defense
-- in depth, since no non-service-role caller ever touches Storage
-- directly in this design.
insert into storage.buckets (id, name, public, file_size_limit)
values ('meeting-recordings', 'meeting-recordings', false, 52428800); -- 50MiB, matches supabase/config.toml's local default
```

- [ ] **Step 2: Apply the migration to the local database**

Run: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -f supabase/migrations/20260912180001_meeting_recordings.sql`

Expected: `CREATE TABLE`, `CREATE TRIGGER`, `ALTER TABLE`, `CREATE POLICY`, `INSERT 0 1` — no errors.

- [ ] **Step 3: Verify the schema landed correctly**

Run: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "\d public.meeting_recordings"`

Expected: all columns present with the types above, the `unique (organization_id, meeting_id)` constraint listed, the `meeting_recordings_select_meeting_visible` policy listed, `byte_size > 0` check constraint listed.

Run: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "select id, name, public from storage.buckets where id = 'meeting-recordings'"`

Expected: one row, `public = f`.

- [ ] **Step 4: Write the failing pgTAP test**

```sql
-- supabase/tests/database/023_meeting_recordings_rls.test.sql

-- Confirms meeting_recordings_select_meeting_visible correctly composes
-- with meetings' own RLS (same-org visible member can see it, cross-org
-- member cannot), and that the (organization_id, meeting_id) uniqueness
-- constraint is real and enforced.

begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into public.organizations (id, name, slug, email_domain) values
  ('98000000-0000-0000-0000-0000000000c1', 'M17C Recordings Test Org A', 'm17c-rec-org-a', 'm17crecA.test'),
  ('98000000-0000-0000-0000-0000000000c2', 'M17C Recordings Test Org B', 'm17c-rec-org-b', 'm17crecB.test');

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', 'am-a@m17crecA.test', 'AM Org A', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into public.organization_memberships (id, organization_id, work_email, display_name, role_id, status)
select '98100000-0000-0000-0000-0000000000c2', '98000000-0000-0000-0000-0000000000c2', 'am-b@m17crecB.test', 'AM Org B', id, 'invited'
from public.roles where key = 'account_manager' and organization_id is null;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, is_super_admin, confirmation_token, recovery_token, email_change_token_new, email_change) values
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'am-a@m17crecA.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '98200000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'am-b@m17crecB.test', '', now(), now(), now(), '{}', '{}', false, '', '', '', '');

-- meetings row owned by Org A, minimal required fields per meetings schema.
insert into public.meetings (id, organization_id, provider, title, ical_uid, organizer_email, scheduled_start, scheduled_end, lifecycle_status, eligibility_status)
values ('98300000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', 'microsoft', 'Recording RLS Test Meeting', 'rls-test-uid-c1', 'am-a@m17crecA.test', now(), now() + interval '30 minutes', 'upcoming', 'record');

insert into public.meeting_recordings (id, organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, source_provider)
values ('98400000-0000-0000-0000-0000000000c1', '98000000-0000-0000-0000-0000000000c1', '98300000-0000-0000-0000-0000000000c1', 'meeting-recordings', 'organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/original.webm', 'audio/webm', 12345, 'vexa');

create or replace function pg_temp.tests_as(p_user_id uuid) returns void as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('role', 'authenticated', true);
end;
$$ language plpgsql;

-- 1: Org A member sees the row.
select pg_temp.tests_as('98200000-0000-0000-0000-0000000000c1');
select is(
  (select count(*)::int from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  1, '1. Same-org member sees the meeting_recordings row via meeting_recordings_select_meeting_visible'
);
select is(
  (select storage_path from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  'organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/original.webm',
  '2. Same-org member sees the real storage_path (not filtered/redacted)'
);

-- 3: Org B member (cross-org) does NOT see it.
reset role;
select pg_temp.tests_as('98200000-0000-0000-0000-0000000000c2');
select is(
  (select count(*)::int from public.meeting_recordings where id = '98400000-0000-0000-0000-0000000000c1'),
  0, '3. Cross-org member cannot see the recording row'
);

reset role;

-- 4: uniqueness constraint is real.
select throws_ok(
  $$insert into public.meeting_recordings (organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, source_provider)
    values ('98000000-0000-0000-0000-0000000000c1', '98300000-0000-0000-0000-0000000000c1', 'meeting-recordings', 'organizations/x/meetings/y/original.webm', 'audio/webm', 1, 'vexa')$$,
  '23505',
  null,
  '4. A second recording row for the same meeting_id is rejected by the unique constraint'
);

-- 5: byte_size must be positive.
select throws_ok(
  $$insert into public.meeting_recordings (organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, source_provider)
    values ('98000000-0000-0000-0000-0000000000c2', '98300000-0000-0000-0000-0000000000c1', 'meeting-recordings', 'organizations/x/meetings/z/original.webm', 'audio/webm', 0, 'vexa')$$,
  '23514',
  null,
  '5. byte_size <= 0 is rejected by the check constraint'
);

select finish();
rollback;
```

- [ ] **Step 5: Run the pgTAP test and verify it passes**

Run: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -f supabase/tests/database/023_meeting_recordings_rls.test.sql`

Expected output ends with: `# All tests successful.` and `1..5` with all 5 lines starting `ok`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260912180001_meeting_recordings.sql supabase/tests/database/023_meeting_recordings_rls.test.sql
git commit -m "feat(recordings): add owned recording schema and RLS"
```

---

## Task 2 — Regenerate types, storage path helper, domain types

**Files:**
- Modify: `packages/database/src/types.ts`
- Create: `packages/domain/src/meeting-recordings.ts` (initial: types + path helper only)
- Create: `packages/domain/src/meeting-recordings.test.ts` (initial: path helper test only)

**Interfaces:**
- Produces: `export function getMeetingRecordingStoragePath(organizationId: string, meetingId: string, extension: string): string`
- Produces: `export interface OwnedRecordingRef { id, organizationId, meetingId, storageBucket, storagePath, contentType, byteSize, durationSeconds, checksumSha256, capturedAt }` — the provider-independent shape from spec §5, deliberately excluding `source_metadata` (kept internal to the module per spec §10 — "provider-specific metadata... hidden from normal AM UI").
- Produces: `export const MEETING_RECORDINGS_BUCKET = "meeting-recordings"`

- [ ] **Step 1: Regenerate database types**

Run: `cd "$(git rev-parse --show-toplevel)" && supabase gen types typescript --local > /tmp/generated-types.ts 2>/tmp/gen-types-stderr.log && diff packages/database/src/types.ts /tmp/generated-types.ts | grep meeting_recordings`

Expected: diff shows new `meeting_recordings` block content (confirms the generator sees the new table). Do NOT copy the raw generated file over the committed one — it isn't Prettier-formatted (confirmed during the M17C bot-dispatch-timing work tonight that this produces a huge unrelated formatting diff). Instead:

- [ ] **Step 2: Hand-edit `packages/database/src/types.ts`**

Find the alphabetically-correct insertion point (this file's tables are alphabetically ordered — `meeting_recordings` sorts between `meeting_policy_sets` and `meeting_transcripts`) and insert, matching the exact style (semicolons, one property per line) of every other table block in this file:

```typescript
      meeting_recordings: {
        Row: {
          byte_size: number;
          captured_at: string | null;
          checksum_sha256: string | null;
          content_type: string;
          created_at: string;
          duration_seconds: number | null;
          id: string;
          meeting_id: string;
          organization_id: string;
          source_metadata: Json;
          source_provider: string;
          storage_bucket: string;
          storage_path: string;
          updated_at: string;
        };
        Insert: {
          byte_size: number;
          captured_at?: string | null;
          checksum_sha256?: string | null;
          content_type: string;
          created_at?: string;
          duration_seconds?: number | null;
          id?: string;
          meeting_id: string;
          organization_id: string;
          source_metadata?: Json;
          source_provider: string;
          storage_bucket: string;
          storage_path: string;
          updated_at?: string;
        };
        Update: {
          byte_size?: number;
          captured_at?: string | null;
          checksum_sha256?: string | null;
          content_type?: string;
          created_at?: string;
          duration_seconds?: number | null;
          id?: string;
          meeting_id?: string;
          organization_id?: string;
          source_metadata?: Json;
          source_provider?: string;
          storage_bucket?: string;
          storage_path?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "meeting_recordings_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "meeting_recordings_meeting_id_fkey";
            columns: ["meeting_id"];
            isOneToOne: false;
            referencedRelation: "meetings";
            referencedColumns: ["id"];
          },
        ];
      };
```

Verify the exact foreign key constraint names by running: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -c "\d public.meeting_recordings" | grep -i "foreign key"` and correct the `foreignKeyName` values above if Postgres auto-generated different names than assumed.

- [ ] **Step 3: Typecheck the database package**

Run: `pnpm --filter @applywizz/database typecheck`

Expected: no errors.

- [ ] **Step 4: Write the failing test for the path helper**

```typescript
// packages/domain/src/meeting-recordings.test.ts
import { describe, expect, it } from "vitest";
import { getMeetingRecordingStoragePath, MEETING_RECORDINGS_BUCKET } from "./meeting-recordings";

describe("getMeetingRecordingStoragePath", () => {
  it("builds the exact deterministic path from the spec", () => {
    const path = getMeetingRecordingStoragePath(
      "98000000-0000-0000-0000-0000000000c1",
      "98300000-0000-0000-0000-0000000000c1",
      "webm",
    );
    expect(path).toBe(
      "organizations/98000000-0000-0000-0000-0000000000c1/meetings/98300000-0000-0000-0000-0000000000c1/original.webm",
    );
  });

  it("is the ONLY place path construction happens — same inputs always produce the same path", () => {
    const a = getMeetingRecordingStoragePath("org-1", "meeting-1", "webm");
    const b = getMeetingRecordingStoragePath("org-1", "meeting-1", "webm");
    expect(a).toBe(b);
  });
});

describe("MEETING_RECORDINGS_BUCKET", () => {
  it("matches the bucket created in the migration", () => {
    expect(MEETING_RECORDINGS_BUCKET).toBe("meeting-recordings");
  });
});
```

- [ ] **Step 5: Run the test, confirm it fails for the right reason**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: fails with `Cannot find module './meeting-recordings'` or similar — the module doesn't exist yet.

- [ ] **Step 6: Create the module with types and the path helper**

```typescript
// packages/domain/src/meeting-recordings.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@applywizz/database/types";

export type AppSupabaseClient = SupabaseClient<Database>;

export const MEETING_RECORDINGS_BUCKET = "meeting-recordings";

/**
 * One helper owns path construction — nothing else in this codebase
 * builds a meeting_recordings storage path. Deterministic by design
 * (spec §6): the SAME organizationId+meetingId always produces the SAME
 * path, which is what makes crash recovery (Task 5) possible without
 * needing to look anything up first.
 */
export function getMeetingRecordingStoragePath(
  organizationId: string,
  meetingId: string,
  extension: string,
): string {
  return `organizations/${organizationId}/meetings/${meetingId}/original.${extension}`;
}

/**
 * Provider-independent shape (spec §5/§10) — deliberately does not
 * include source_metadata, which stays internal to this module and is
 * only ever surfaced through the admin-only Technical Details path
 * Meeting Detail already established, never through this type.
 */
export interface OwnedRecordingRef {
  id: string;
  organizationId: string;
  meetingId: string;
  storageBucket: string;
  storagePath: string;
  contentType: string;
  byteSize: number;
  durationSeconds: number | null;
  checksumSha256: string | null;
  capturedAt: string | null;
}

type MeetingRecordingRow = Database["public"]["Tables"]["meeting_recordings"]["Row"];

function toOwnedRecordingRef(row: MeetingRecordingRow): OwnedRecordingRef {
  return {
    id: row.id,
    organizationId: row.organization_id,
    meetingId: row.meeting_id,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    contentType: row.content_type,
    byteSize: row.byte_size,
    durationSeconds: row.duration_seconds,
    checksumSha256: row.checksum_sha256,
    capturedAt: row.captured_at,
  };
}
```

- [ ] **Step 7: Run the test, verify it passes**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: 3 passed.

- [ ] **Step 8: Add the package export**

In `packages/domain/package.json`, add to `"exports"` (alphabetically near `"./meeting-policy"`):

```json
    "./meeting-recordings": "./src/meeting-recordings.ts",
```

- [ ] **Step 9: Typecheck the whole domain package**

Run: `pnpm --filter @applywizz/domain typecheck`

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/database/src/types.ts packages/domain/src/meeting-recordings.ts packages/domain/src/meeting-recordings.test.ts packages/domain/package.json
git commit -m "feat(recordings): add owned-recording types and deterministic storage path helper"
```

---

## Task 3 — `getOwnedMeetingRecording` (read path)

**Files:**
- Modify: `packages/domain/src/meeting-recordings.ts`
- Modify: `packages/domain/src/meeting-recordings.test.ts`

**Interfaces:**
- Consumes: `AppSupabaseClient` (service-role, from Task 2).
- Produces: `export async function getOwnedMeetingRecording(supabase: AppSupabaseClient, meetingId: string): Promise<OwnedRecordingRef | null>`

- [ ] **Step 1: Write the failing test**

```typescript
// append to packages/domain/src/meeting-recordings.test.ts
import { getOwnedMeetingRecording } from "./meeting-recordings";

function fakeSupabase(row: unknown) {
  return {
    from(table: string) {
      if (table !== "meeting_recordings") throw new Error(`unexpected table: ${table}`);
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: row, error: null };
        },
      };
    },
  } as unknown as Parameters<typeof getOwnedMeetingRecording>[0];
}

describe("getOwnedMeetingRecording", () => {
  it("returns null when no recording is owned yet", async () => {
    const result = await getOwnedMeetingRecording(fakeSupabase(null), "meeting-1");
    expect(result).toBeNull();
  });

  it("maps the real row shape to OwnedRecordingRef", async () => {
    const result = await getOwnedMeetingRecording(
      fakeSupabase({
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: 474476,
        duration_seconds: null,
        checksum_sha256: "abc123",
        captured_at: null,
      }),
      "meeting-1",
    );
    expect(result).toEqual({
      id: "rec-1",
      organizationId: "org-1",
      meetingId: "meeting-1",
      storageBucket: "meeting-recordings",
      storagePath: "organizations/org-1/meetings/meeting-1/original.webm",
      contentType: "audio/webm",
      byteSize: 474476,
      durationSeconds: null,
      checksumSha256: "abc123",
      capturedAt: null,
    });
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: fails — `getOwnedMeetingRecording is not a function`.

- [ ] **Step 3: Implement**

```typescript
// append to packages/domain/src/meeting-recordings.ts
export async function getOwnedMeetingRecording(
  supabase: AppSupabaseClient,
  meetingId: string,
): Promise<OwnedRecordingRef | null> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select(
      "id, organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: 5 passed (3 from Task 2 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/meeting-recordings.ts packages/domain/src/meeting-recordings.test.ts
git commit -m "feat(recordings): add getOwnedMeetingRecording read path"
```

---

## Task 4 — `ensureOwnedRecording`: fresh ingestion (happy path)

**Files:**
- Modify: `packages/domain/src/meeting-recordings.ts`
- Modify: `packages/domain/src/meeting-recordings.test.ts`

**Interfaces:**
- Consumes: `VexaEnv` (`@applywizz/meeting-bots`), `getMeetingRecordingRef`/`downloadRecordingMedia` (`@applywizz/meeting-bots`, unchanged).
- Produces: `export class RecordingStorageMismatchError extends Error` (new, distinct from `RecordingNotReadyError`).
- Produces: `export async function ensureOwnedRecording(supabase: AppSupabaseClient, storage: RecordingStorageClient, input: { organizationId: string; meetingId: string; vexaMeetingId: number; vexaEnv: VexaEnv; fetchImpl?: typeof fetch }): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }>`
- Produces (internal, exported for testability): `export interface RecordingStorageClient { upload(path: string, body: ArrayBuffer, opts: { contentType: string; upsert: boolean }): Promise<{ error: { message: string } | null }>; download(path: string): Promise<{ data: Blob | null; error: unknown }>; info(path: string): Promise<{ data: { size: number; contentType?: string } | null; error: unknown }>; }` — a minimal, duck-typed subset of `@supabase/storage-js`'s real `StorageFileApi` (confirmed method signatures during planning), not the full SDK type, so it stays independently fakeable and doesn't leak a Supabase-specific type through the domain module's public interface — same duck-typing discipline already used for `extractRetryAfterSeconds` in `meeting-bots.ts`.

This task covers only the case where nothing exists yet at the deterministic path — Task 5 covers the crash-recovery/mismatch branches.

- [ ] **Step 1: Write the failing test**

```typescript
// append to packages/domain/src/meeting-recordings.test.ts
import { ensureOwnedRecording, RecordingStorageMismatchError, type RecordingStorageClient } from "./meeting-recordings";

function fakeRecordingsTable(insertSpy: (payload: unknown) => { data: unknown; error: unknown }) {
  return {
    from(table: string) {
      if (table !== "meeting_recordings") throw new Error(`unexpected table: ${table}`);
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          return { data: null, error: null }; // no existing row
        },
        insert(payload: unknown) {
          builder._insertPayload = payload;
          return builder;
        },
        async single() {
          return insertSpy(builder._insertPayload);
        },
        _insertPayload: undefined as unknown,
      };
      return builder;
    },
  } as unknown as Parameters<typeof ensureOwnedRecording>[0];
}

function fakeVexaFetch(mediaBytes: ArrayBuffer): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/recordings?meeting_id=")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: 860952982728,
              status: "completed",
              media_files: [{ id: 559299580948, type: "audio", format: "webm", file_size_bytes: mediaBytes.byteLength }],
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/media/")) {
      return new Response(mediaBytes, { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  }) as unknown as typeof fetch;
}

describe("ensureOwnedRecording — fresh ingestion", () => {
  it("downloads from Vexa, uploads to Storage, inserts the row, and returns the bytes — when nothing is owned yet", async () => {
    const mediaBytes = new TextEncoder().encode("fake-audio-bytes").buffer;
    const insertSpy = vi.fn((payload: unknown) => ({
      data: {
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: mediaBytes.byteLength,
        duration_seconds: null,
        checksum_sha256: expect.any(String),
        captured_at: null,
      },
      error: null,
    }));
    const supabase = fakeRecordingsTable(insertSpy);

    const uploadSpy = vi.fn(async () => ({ error: null }));
    const infoSpy = vi.fn(async () => ({ data: null, error: { message: "not found" } })); // nothing at the path yet
    const storage: RecordingStorageClient = {
      upload: uploadSpy,
      download: vi.fn(),
      info: infoSpy,
    };

    const result = await ensureOwnedRecording(supabase, storage, {
      organizationId: "org-1",
      meetingId: "meeting-1",
      vexaMeetingId: 28075,
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
      fetchImpl: fakeVexaFetch(mediaBytes),
    });

    expect(infoSpy).toHaveBeenCalledWith("organizations/org-1/meetings/meeting-1/original.webm");
    expect(uploadSpy).toHaveBeenCalledWith(
      "organizations/org-1/meetings/meeting-1/original.webm",
      expect.anything(),
      { contentType: "audio/webm", upsert: false },
    );
    expect(insertSpy).toHaveBeenCalled();
    expect(result.recordingRef.storagePath).toBe("organizations/org-1/meetings/meeting-1/original.webm");
    expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(mediaBytes));
  });

  it("throws RecordingNotReadyError when Vexa has no completed recording yet — reuses the existing error, no new retry classification needed", async () => {
    const supabase = fakeRecordingsTable(vi.fn());
    const storage: RecordingStorageClient = { upload: vi.fn(), download: vi.fn(), info: vi.fn() };
    const noRecordingFetch = (async (url: string | URL) => {
      if (String(url).includes("/recordings?meeting_id=")) {
        return new Response(JSON.stringify({ recordings: [] }), { status: 200 });
      }
      throw new Error("should not reach media download");
    }) as unknown as typeof fetch;

    await expect(
      ensureOwnedRecording(supabase, storage, {
        organizationId: "org-1",
        meetingId: "meeting-1",
        vexaMeetingId: 28075,
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
        fetchImpl: noRecordingFetch,
      }),
    ).rejects.toThrow("No completed Vexa recording is available for this meeting yet.");
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: fails — `ensureOwnedRecording is not a function`.

- [ ] **Step 3: Implement the happy path**

```typescript
// append to packages/domain/src/meeting-recordings.ts
import { createHash } from "node:crypto";
import {
  downloadRecordingMedia,
  getMeetingRecordingRef,
  type VexaEnv,
} from "@applywizz/meeting-bots";

/** Duck-typed subset of @supabase/storage-js's real StorageFileApi (v2.115.0, confirmed during planning) — kept minimal and independently fakeable rather than importing the full SDK type. */
export interface RecordingStorageClient {
  upload(
    path: string,
    body: ArrayBuffer,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: unknown }>;
  info(path: string): Promise<{ data: { size: number; contentType?: string } | null; error: unknown }>;
}

export class RecordingStorageMismatchError extends Error {
  constructor() {
    super(
      "An object already exists at this recording's storage path but does not match the expected recording — refusing to overwrite.",
    );
    this.name = "RecordingStorageMismatchError";
  }
}

// Re-exported from transcription.ts's own definition would create a
// circular import (transcription.ts will import FROM this module in
// Task 7) — this module owns its own copy of the same error shape,
// matching it exactly so transcription.ts's existing classifyError
// continues to work unmodified.
export class RecordingNotReadyError extends Error {
  constructor() {
    super("No completed Vexa recording is available for this meeting yet.");
    this.name = "RecordingNotReadyError";
  }
}

export interface EnsureOwnedRecordingInput {
  organizationId: string;
  meetingId: string;
  vexaMeetingId: number;
  vexaEnv: VexaEnv;
  fetchImpl?: typeof fetch;
}

export async function ensureOwnedRecording(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: EnsureOwnedRecordingInput,
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  const existing = await getOwnedMeetingRecording(supabase, input.meetingId);
  if (existing) {
    const { data, error } = await storage.download(existing.storagePath);
    if (error || !data) throw error ?? new Error("Owned recording download returned no data.");
    const bytes = await data.arrayBuffer();
    return { recordingRef: existing, bytes };
  }

  const vexaRecording = await getMeetingRecordingRef(
    input.vexaEnv,
    input.vexaMeetingId,
    input.fetchImpl,
  );
  if (!vexaRecording) throw new RecordingNotReadyError();

  const path = getMeetingRecordingStoragePath(
    input.organizationId,
    input.meetingId,
    vexaRecording.format,
  );
  const contentType = `audio/${vexaRecording.format}`;

  const preexisting = await storage.info(path);
  if (preexisting.data) {
    return reconcilePreexistingObject(supabase, storage, input, path, contentType, preexisting.data.size);
  }

  const bytes = await downloadRecordingMedia(
    input.vexaEnv,
    vexaRecording.recordingId,
    vexaRecording.mediaFileId,
    input.fetchImpl,
  );
  const checksum = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

  const uploadResult = await storage.upload(path, bytes, { contentType, upsert: false });
  if (uploadResult.error) {
    // Someone else uploaded between our info() check and our upload —
    // re-run the same reconciliation path rather than trusting our own
    // in-memory bytes over whatever is actually there now.
    return reconcilePreexistingObject(supabase, storage, input, path, contentType, bytes.byteLength, { checksum, bytes });
  }

  const row = await insertRecordingRow(supabase, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    bucket: MEETING_RECORDINGS_BUCKET,
    path,
    contentType,
    byteSize: bytes.byteLength,
    checksum,
    sourceMetadata: {
      recordingId: vexaRecording.recordingId,
      mediaFileId: vexaRecording.mediaFileId,
      sourceFileSizeBytes: bytes.byteLength,
      sourceFormat: vexaRecording.format,
    },
  });

  return { recordingRef: row, bytes };
}
```

- [ ] **Step 4: Add the two small helpers this implementation calls** (stubs sufficient for this task; `reconcilePreexistingObject`'s real logic is Task 5 — for now it only needs to satisfy Task 4's tests, which never exercise it)

```typescript
// append to packages/domain/src/meeting-recordings.ts

async function insertRecordingRow(
  supabase: AppSupabaseClient,
  input: {
    organizationId: string;
    meetingId: string;
    bucket: string;
    path: string;
    contentType: string;
    byteSize: number;
    checksum: string;
    sourceMetadata: Json;
  },
): Promise<OwnedRecordingRef> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .insert({
      organization_id: input.organizationId,
      meeting_id: input.meetingId,
      storage_bucket: input.bucket,
      storage_path: input.path,
      content_type: input.contentType,
      byte_size: input.byteSize,
      checksum_sha256: input.checksum,
      source_provider: "vexa",
      source_metadata: input.sourceMetadata,
    })
    .select(
      "id, organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .single();
  if (error) throw error;
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}

// Task 5 replaces this body with the real validate-then-reconcile logic.
// For Task 4's scope, this is only reachable if Storage already had an
// object at a brand-new path, which none of this task's tests exercise.
async function reconcilePreexistingObject(
  _supabase: AppSupabaseClient,
  _storage: RecordingStorageClient,
  _input: EnsureOwnedRecordingInput,
  _path: string,
  _contentType: string,
  _observedSize: number,
  _freshlyDownloaded?: { checksum: string; bytes: ArrayBuffer },
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  throw new Error("reconcilePreexistingObject is implemented in Task 5");
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: 7 passed (5 from Tasks 2–3 + 2 new). The "not ready" test never reaches `reconcilePreexistingObject`, so its stub throw is never hit.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @applywizz/domain typecheck`

Expected: no errors. (`Json` import from `@applywizz/database/types` — confirm it's already exported there, matching how `transcription.ts` already imports it today.)

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/meeting-recordings.ts packages/domain/src/meeting-recordings.test.ts
git commit -m "feat(recordings): add ensureOwnedRecording fresh-ingestion happy path"
```

---

## Task 5 — Crash recovery and mismatch (fail closed)

**Files:**
- Modify: `packages/domain/src/meeting-recordings.ts`
- Modify: `packages/domain/src/meeting-recordings.test.ts`

**Interfaces:**
- Replaces the Task 4 stub body of `reconcilePreexistingObject` with real logic.

This is the task named explicitly in review as requiring its own dedicated tests — both the match (reconcile) and mismatch (fail closed) cases.

- [ ] **Step 1: Write the two failing tests**

```typescript
// append to packages/domain/src/meeting-recordings.test.ts
describe("ensureOwnedRecording — crash recovery (object exists, no DB row)", () => {
  it("reconciles without re-uploading or re-downloading when the existing object matches Vexa's reported size", async () => {
    const expectedSize = 474476;
    const insertSpy = vi.fn((payload: unknown) => ({
      data: {
        id: "rec-1",
        organization_id: "org-1",
        meeting_id: "meeting-1",
        storage_bucket: "meeting-recordings",
        storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
        content_type: "audio/webm",
        byte_size: expectedSize,
        duration_seconds: null,
        checksum_sha256: null, // never computed — we didn't download it ourselves this time
        captured_at: null,
      },
      error: null,
    }));
    const supabase = fakeRecordingsTable(insertSpy);

    const downloadedBytes = new TextEncoder().encode("x".repeat(expectedSize)).buffer;
    const uploadSpy = vi.fn(); // must NEVER be called in this test
    const downloadSpy = vi.fn(async () => ({ data: new Blob([downloadedBytes]), error: null }));
    const infoSpy = vi.fn(async () => ({ data: { size: expectedSize, contentType: "audio/webm" }, error: null }));
    const storage: RecordingStorageClient = { upload: uploadSpy, download: downloadSpy, info: infoSpy };

    const result = await ensureOwnedRecording(supabase, storage, {
      organizationId: "org-1",
      meetingId: "meeting-1",
      vexaMeetingId: 28075,
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
      fetchImpl: fakeVexaFetch(new ArrayBuffer(expectedSize)),
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(insertSpy).toHaveBeenCalled();
    expect(result.recordingRef.byteSize).toBe(expectedSize);
  });

  it("fails closed — never overwrites — when the existing object's size does not match Vexa's reported size", async () => {
    const insertSpy = vi.fn();
    const supabase = fakeRecordingsTable(insertSpy);

    const uploadSpy = vi.fn();
    const infoSpy = vi.fn(async () => ({ data: { size: 999, contentType: "audio/webm" }, error: null })); // wrong size
    const storage: RecordingStorageClient = { upload: uploadSpy, download: vi.fn(), info: infoSpy };

    await expect(
      ensureOwnedRecording(supabase, storage, {
        organizationId: "org-1",
        meetingId: "meeting-1",
        vexaMeetingId: 28075,
        vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
        fetchImpl: fakeVexaFetch(new ArrayBuffer(474476)), // Vexa says 474476, Storage has 999
      }),
    ).rejects.toBeInstanceOf(RecordingStorageMismatchError);

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests, confirm they fail**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: both new tests fail — the first with the stub's `"reconcilePreexistingObject is implemented in Task 5"` error, the second the same.

- [ ] **Step 3: Implement the real reconciliation logic**

```typescript
// replace the Task 4 stub in packages/domain/src/meeting-recordings.ts
async function reconcilePreexistingObject(
  supabase: AppSupabaseClient,
  storage: RecordingStorageClient,
  input: EnsureOwnedRecordingInput,
  path: string,
  contentType: string,
  expectedSizeFromVexa: number,
  freshlyDownloaded?: { checksum: string; bytes: ArrayBuffer },
): Promise<{ recordingRef: OwnedRecordingRef; bytes: ArrayBuffer }> {
  const { data: objectInfo, error: infoError } = await storage.info(path);
  if (infoError || !objectInfo) throw infoError ?? new Error("Expected an existing object but info() found none.");

  if (objectInfo.size !== expectedSizeFromVexa) {
    throw new RecordingStorageMismatchError();
  }

  const row = await insertRecordingRow(supabase, {
    organizationId: input.organizationId,
    meetingId: input.meetingId,
    bucket: MEETING_RECORDINGS_BUCKET,
    path,
    contentType,
    byteSize: objectInfo.size,
    checksum: freshlyDownloaded?.checksum ?? "",
    sourceMetadata: {
      reconciled: true,
      sourceFileSizeBytes: expectedSizeFromVexa,
    },
  });

  if (freshlyDownloaded) {
    return { recordingRef: row, bytes: freshlyDownloaded.bytes };
  }
  const { data, error } = await storage.download(path);
  if (error || !data) throw error ?? new Error("Reconciled recording download returned no data.");
  return { recordingRef: row, bytes: await data.arrayBuffer() };
}
```

Note: `checksum: freshlyDownloaded?.checksum ?? ""` stores an empty string when we never actually downloaded the bytes ourselves (the pure-crash-recovery case) — `checksum_sha256` is nullable in the schema; this plan uses `""` only as an internal sentinel inside `insertRecordingRow`'s current signature. **Self-correction during review:** this is imprecise — fix `insertRecordingRow`'s `checksum` parameter to `string | null` and pass `null` here instead of `""`, so the persisted column is genuinely `null`, not a misleading empty string. Apply this fix in Step 3 before running tests, not as a follow-up.

- [ ] **Step 4: Run the tests, verify all pass**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/meeting-recordings.ts packages/domain/src/meeting-recordings.test.ts
git commit -m "feat(recordings): make ingestion crash-safe — reconcile matching objects, fail closed on mismatch"
```

---

## Task 6 — Concurrent callers (race safety)

**Files:**
- Modify: `packages/domain/src/meeting-recordings.ts`
- Modify: `packages/domain/src/meeting-recordings.test.ts`

**Interfaces:**
- Modifies `insertRecordingRow` to tolerate a `23505` (duplicate) error by re-reading instead of throwing — the exact idiom already used in `syncMeetingBotIntent` (`meeting-bots.ts`) and `enqueuePendingTranscriptions` (`transcription.ts`).

Storage-object idempotency (two callers racing to upload) is already covered by Task 4's `upload` → `reconcilePreexistingObject` fallback path. This task covers the *database-row* idempotency specifically — two callers that both pass the `preexisting`/upload checks and both attempt to `INSERT` the same `(organization_id, meeting_id)` row.

- [ ] **Step 1: Write the failing test**

```typescript
// append to packages/domain/src/meeting-recordings.test.ts
describe("ensureOwnedRecording — concurrent DB insert race", () => {
  it("treats a 23505 duplicate-insert error as 'someone else already reconciled it', not a failure", async () => {
    const existingRow = {
      id: "rec-1",
      organization_id: "org-1",
      meeting_id: "meeting-1",
      storage_bucket: "meeting-recordings",
      storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
      content_type: "audio/webm",
      byte_size: 474476,
      duration_seconds: null,
      checksum_sha256: "abc123",
      captured_at: null,
    };
    let selectCallCount = 0;
    const supabase = {
      from(table: string) {
        if (table !== "meeting_recordings") throw new Error(`unexpected table: ${table}`);
        const builder = {
          select() {
            return builder;
          },
          eq() {
            return builder;
          },
          async maybeSingle() {
            selectCallCount += 1;
            // First call (the initial getOwnedMeetingRecording check): not owned yet.
            // Second call (after the insert loses the race): the winner's row is now visible.
            return selectCallCount === 1 ? { data: null, error: null } : { data: existingRow, error: null };
          },
          insert() {
            return builder;
          },
          async single() {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          },
        };
        return builder;
      },
    } as unknown as Parameters<typeof ensureOwnedRecording>[0];

    const bytes = new ArrayBuffer(474476);
    const storage: RecordingStorageClient = {
      upload: vi.fn(async () => ({ error: null })),
      download: vi.fn(),
      info: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
    };

    const result = await ensureOwnedRecording(supabase, storage, {
      organizationId: "org-1",
      meetingId: "meeting-1",
      vexaMeetingId: 28075,
      vexaEnv: { baseUrl: "https://vexa.test", apiKey: "test-key" },
      fetchImpl: fakeVexaFetch(bytes),
    });

    expect(result.recordingRef.id).toBe("rec-1");
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: fails — `insertRecordingRow` currently does `if (error) throw error;` unconditionally, so the `23505` propagates as an uncaught rejection instead of resolving.

- [ ] **Step 3: Implement the 23505-tolerant insert**

```typescript
// replace insertRecordingRow's body in packages/domain/src/meeting-recordings.ts
async function insertRecordingRow(
  supabase: AppSupabaseClient,
  input: {
    organizationId: string;
    meetingId: string;
    bucket: string;
    path: string;
    contentType: string;
    byteSize: number;
    checksum: string | null;
    sourceMetadata: Json;
  },
): Promise<OwnedRecordingRef> {
  const { data, error } = await supabase
    .from("meeting_recordings")
    .insert({
      organization_id: input.organizationId,
      meeting_id: input.meetingId,
      storage_bucket: input.bucket,
      storage_path: input.path,
      content_type: input.contentType,
      byte_size: input.byteSize,
      checksum_sha256: input.checksum,
      source_provider: "vexa",
      source_metadata: input.sourceMetadata,
    })
    .select(
      "id, organization_id, meeting_id, storage_bucket, storage_path, content_type, byte_size, duration_seconds, checksum_sha256, captured_at",
    )
    .single();

  if (error) {
    // Same idempotency idiom as syncMeetingBotIntent (meeting-bots.ts)
    // and enqueuePendingTranscriptions (transcription.ts): a 23505 here
    // IS the unique(organization_id, meeting_id) constraint working, not
    // a real error — a concurrent caller already won this exact insert.
    if ((error as { code?: string }).code === "23505") {
      const existing = await getOwnedMeetingRecording(supabase, input.meetingId);
      if (existing) return existing;
    }
    throw error;
  }
  return toOwnedRecordingRef(data as MeetingRecordingRow);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm --filter @applywizz/domain test -- run meeting-recordings.test.ts`

Expected: 10 passed.

- [ ] **Step 5: Run the full domain suite to confirm no regressions**

Run: `pnpm --filter @applywizz/domain test -- run`

Expected: all pre-existing tests (275 before this plan) still pass, plus the 10 new `meeting-recordings.test.ts` tests.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/meeting-recordings.ts packages/domain/src/meeting-recordings.test.ts
git commit -m "feat(recordings): tolerate concurrent DB-insert races via existing 23505 idiom"
```

---

## Task 7 — Wire into `processTranscriptionJob`, prove Vexa independence

**Files:**
- Modify: `packages/domain/src/transcription.ts`
- Modify: `packages/domain/src/transcription.test.ts`

**Interfaces:**
- Consumes: `ensureOwnedRecording` from Task 6, plus a real `RecordingStorageClient` implementation constructed from `serviceRoleClient.storage.from(MEETING_RECORDINGS_BUCKET)` (this is the one place in the whole plan where the duck-typed interface meets the real Supabase Storage SDK — confirmed method-compatible during Phase 0).

- [ ] **Step 1: Write the failing test — recording ingested once, Vexa unavailable on retry, transcription still succeeds**

```typescript
// add to packages/domain/src/transcription.test.ts, near the existing processTranscriptionJob describe block
import { ensureOwnedRecording } from "./meeting-recordings";

it("does not call any Vexa endpoint when the recording is already owned — proves Vexa independence after ingestion", async () => {
  const tables = makeTables();
  tables.meeting_bot_jobs.rows.push({ ...baseJob });
  const transcript = {
    id: "t1",
    organization_id: "org-1",
    meeting_id: "meeting-1",
    processing_status: "processing",
    retry_count: 0,
  };
  tables.meeting_transcripts.rows.push(transcript);

  // meeting_recordings already has a row — owned, per Task 6's shape.
  const ownedRow = {
    id: "rec-1",
    organization_id: "org-1",
    meeting_id: "meeting-1",
    storage_bucket: "meeting-recordings",
    storage_path: "organizations/org-1/meetings/meeting-1/original.webm",
    content_type: "audio/webm",
    byte_size: syntheticAudioBytes.byteLength,
    duration_seconds: null,
    checksum_sha256: "abc123",
    captured_at: null,
  };

  const supabase = createFakeSupabase(tables, { meeting_recordings: ownedRow });

  let vexaEndpointCalled = false;
  const vexaCallDetectingFetch = (async (url: string | URL) => {
    vexaEndpointCalled = true;
    throw new Error(`Vexa was contacted but should not have been: ${String(url)}`);
  }) as unknown as typeof fetch;

  const storageDownloadSpy = vi.fn(async () => ({ data: new Blob([syntheticAudioBytes]), error: null }));

  await processTranscriptionJob(supabase, transcript as never, {
    vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
    transcriptionProvider: fakeEnglishProvider(),
    normalizationProvider: fakeNormalizationProvider(),
    fetchImpl: vexaCallDetectingFetch,
    storage: { upload: vi.fn(), download: storageDownloadSpy, info: vi.fn() },
  });

  expect(vexaEndpointCalled).toBe(false);
  expect(storageDownloadSpy).toHaveBeenCalledWith("organizations/org-1/meetings/meeting-1/original.webm");
  expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe("completed");
});
```

This requires `createFakeSupabase` (this file's own existing fake harness) to accept an optional second argument for table-specific fixed-row overrides, and requires `TranscriptionDeps` to accept a `storage` field. Both are added in the implementation step below — check the exact current signature of `createFakeSupabase` in this file before editing, and extend it minimally rather than restructuring it.

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @applywizz/domain test -- run transcription.test.ts`

Expected: fails — `processTranscriptionJob` doesn't accept a `storage` dep yet, and/or `createFakeSupabase` doesn't know about `meeting_recordings`.

- [ ] **Step 3: Extend `TranscriptionDeps` and wire `ensureOwnedRecording` into `processTranscriptionJob`**

In `packages/domain/src/transcription.ts`:

```typescript
// add near the top, alongside the existing imports from "./meeting-bots" etc.
import { ensureOwnedRecording, type RecordingStorageClient, MEETING_RECORDINGS_BUCKET } from "./meeting-recordings";
```

```typescript
// extend the existing TranscriptionDeps interface
export interface TranscriptionDeps {
  vexaEnv: VexaEnv;
  transcriptionProvider: TranscriptionProvider;
  normalizationProvider: EnglishNormalizationProvider;
  storage: RecordingStorageClient;
  fetchImpl?: typeof fetch;
}
```

Replace the current recording-acquisition block inside `processTranscriptionJob` (the `decodeProviderBotId` → `getMeetingRecordingRef` → `downloadRecordingMedia` sequence) with:

```typescript
    const identity = decodeProviderBotId(botJob.provider_bot_id);
    const vexaMeetingId = extractVexaNumericId(botJob.provider_metadata);
    if (vexaMeetingId === null) throw new RecordingNotReadyError();

    const { bytes: rawBytes } = await ensureOwnedRecording(serviceRoleClient, deps.storage, {
      organizationId: transcript.organization_id,
      meetingId: transcript.meeting_id,
      vexaMeetingId,
      vexaEnv: deps.vexaEnv,
      fetchImpl: deps.fetchImpl,
    });
```

`identity` (platform/nativeMeetingId) is still used further down for `p_source_audio_reference` — unchanged. `extractVexaNumericId` is the same helper already added earlier tonight for the recording-retrieval fix (confirm it still exists at its current location in this file before re-adding — if it does, reuse it verbatim; do not duplicate it).

Remove the now-unused direct imports of `getMeetingRecordingRef`/`downloadRecordingMedia` from `"@applywizz/meeting-bots"` in this file **only if** nothing else in `transcription.ts` still calls them directly (confirm via grep before removing).

- [ ] **Step 4: Update `RecordingNotReadyError`'s single source of truth**

`meeting-recordings.ts` (Task 4) already defines its own `RecordingNotReadyError` with identical shape to the one already in `transcription.ts`. To avoid two classes with the same name/message diverging over time: **`transcription.ts` re-exports `meeting-recordings.ts`'s version** instead of keeping its own:

```typescript
// in transcription.ts, replace the existing local `export class RecordingNotReadyError` with:
export { RecordingNotReadyError } from "./meeting-recordings";
```

Update `classifyError`'s `instanceof RecordingNotReadyError` check — no change needed, it already just checks `instanceof`, which continues to work correctly against the re-exported class.

- [ ] **Step 5: Extend the test file's fake harness minimally**

In `packages/domain/src/transcription.test.ts`, find `createFakeSupabase`'s current signature and add support for a `meeting_recordings` fixed-row override (exact shape depends on the current function body — inspect it directly before editing; add the smallest change that lets a test pre-seed a `meeting_recordings` row and has `.select().eq().maybeSingle()` on that table return it).

- [ ] **Step 6: Run the test, verify it passes**

Run: `pnpm --filter @applywizz/domain test -- run transcription.test.ts`

Expected: this new test passes, and every pre-existing `transcription.test.ts` test also still passes (they'll need their own `deps.storage` argument added — see Step 7).

- [ ] **Step 7: Update every pre-existing `processTranscriptionJob` test call site to pass a real `storage` dep**

Every existing test in `transcription.test.ts` that calls `processTranscriptionJob(supabase, transcript, { vexaEnv, transcriptionProvider, normalizationProvider, fetchImpl })` needs a `storage` field added. For tests where `meeting_recordings` has no pre-seeded row (the common case, matching today's fresh-ingestion path), add:

```typescript
storage: {
  upload: vi.fn(async () => ({ error: null })),
  download: vi.fn(),
  info: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
},
```

alongside their existing `fetchImpl: fakeVexaFetch()` (which already correctly mocks the `/recordings?meeting_id=` and `/media/` Vexa endpoints per tonight's earlier fix — unchanged).

- [ ] **Step 8: Run the full transcription test file**

Run: `pnpm --filter @applywizz/domain test -- run transcription.test.ts`

Expected: all tests pass (10 pre-existing + updates + 1 new).

- [ ] **Step 9: Run the full domain suite**

Run: `pnpm --filter @applywizz/domain test -- run`

Expected: all tests pass, zero regressions elsewhere.

- [ ] **Step 10: Typecheck**

Run: `pnpm --filter @applywizz/domain typecheck`

Expected: no errors.

- [ ] **Step 11: Update the transcription worker and internal route to construct the real storage client**

In `workers/transcription-worker/transcription-worker.mjs`, where `deps` is constructed:

```javascript
storage: supabase.storage.from(requiredEnv("MEETING_RECORDINGS_BUCKET_NAME") ?? "meeting-recordings"),
```

(Supabase JS's real `.storage.from(bucket)` object already structurally satisfies the `RecordingStorageClient` interface — `upload`, `download`, `info` all exist with compatible signatures, confirmed in Phase 0. No adapter/wrapper needed.)

Apply the identical one-line change in `apps/web/app/api/internal/transcription/process/route.ts` where its own `deps` object is constructed.

- [ ] **Step 12: Commit**

```bash
git add packages/domain/src/transcription.ts packages/domain/src/transcription.test.ts workers/transcription-worker/transcription-worker.mjs apps/web/app/api/internal/transcription/process/route.ts
git commit -m "feat(transcription): transcribe from owned recordings, never re-contact Vexa once owned"
```

---

## Task 8 — Temp file cleanup regression coverage

**Files:**
- Modify: `packages/domain/src/transcription.test.ts`

No production code changes in this task — `processTranscriptionJob`'s existing `finally { rm(workDir, ...) }` block already only ever deletes its own local `mkdtemp` directory, and Task 7 never introduced any code path that deletes anything from Supabase Storage. This task exists purely to make that guarantee an explicit, checked regression test rather than an implicit property.

- [ ] **Step 1: Write the test**

```typescript
// append to packages/domain/src/transcription.test.ts
it("never deletes the owned Storage object — only the local temp work directory", async () => {
  const tables = makeTables();
  tables.meeting_bot_jobs.rows.push({ ...baseJob });
  const transcript = {
    id: "t1",
    organization_id: "org-1",
    meeting_id: "meeting-1",
    processing_status: "processing",
    retry_count: 0,
  };
  tables.meeting_transcripts.rows.push(transcript);
  const supabase = createFakeSupabase(tables);

  const removeSpy = vi.fn(async () => ({ error: null })); // Storage.remove — must never be called
  await processTranscriptionJob(supabase, transcript as never, {
    vexaEnv: { baseUrl: "https://vexa.test", apiKey: "k" },
    transcriptionProvider: fakeEnglishProvider(),
    normalizationProvider: fakeNormalizationProvider(),
    fetchImpl: fakeVexaFetch(),
    storage: {
      upload: vi.fn(async () => ({ error: null })),
      download: vi.fn(),
      info: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
      remove: removeSpy,
    } as never,
  });

  expect(removeSpy).not.toHaveBeenCalled();
  expect(tables.meeting_transcripts.rows[0]?.processing_status).toBe("completed");
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @applywizz/domain test -- run transcription.test.ts`

Expected: passes immediately — this is a regression test for behavior that already exists correctly after Task 7, not a new feature. If it fails, that means Task 7's implementation somehow introduced a deletion call, which would need to be found and removed before continuing.

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/transcription.test.ts
git commit -m "test(recordings): regression-lock that owned Storage objects are never deleted by transcription"
```

---

## Task 9 — Authorized playback URL route

**Files:**
- Create: `apps/web/app/api/meetings/[id]/recording-url/route.ts`

**Interfaces:**
- Consumes: `getSupabaseServerClient()` (existing, `apps/web/lib/supabase/server.ts`), `createSupabaseServiceRoleClient` (existing), `getOwnedMeetingRecording` (Task 3).

No dedicated test file — matches the existing convention (`/api/meeting-policy/set/route.ts` has none); authorization is exercised by Task 1's pgTAP tests plus Task 11's human test.

- [ ] **Step 1: Implement the route**

```typescript
// apps/web/app/api/meetings/[id]/recording-url/route.ts
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOwnedMeetingRecording } from "@applywizz/domain/meeting-recordings";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getClientEnv } from "@/env/client";
import { getSupabaseServiceRoleKey } from "@/env/server";

const SIGNED_URL_EXPIRY_SECONDS = 600;

/**
 * Authorization path (spec §9, confirmed against the real
 * meeting_transcripts_select_meeting_visible RLS policy during
 * planning): the requester's OWN authenticated client does the read
 * that decides visibility — meeting_recordings' RLS policy is a bare
 * EXISTS against meetings, so meetings' own existing org/manager-scope
 * policies make the real decision, transitively, with zero duplicated
 * logic here. Only after that succeeds does a service-role client ever
 * get constructed, and only to sign a short-lived URL — never to read
 * or return anything else.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: meetingId } = await params;
  const supabase = await getSupabaseServerClient();

  const recording = await getOwnedMeetingRecording(supabase, meetingId);
  if (!recording) {
    return NextResponse.json(
      { error: "No recording is available for this meeting." },
      { status: 404 },
    );
  }

  const clientEnv = getClientEnv();
  const serviceRoleClient = createClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    getSupabaseServiceRoleKey(),
  );
  const { data, error } = await serviceRoleClient.storage
    .from(recording.storageBucket)
    .createSignedUrl(recording.storagePath, SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data) {
    return NextResponse.json(
      { error: "Could not create a playback link right now." },
      { status: 500 },
    );
  }

  return NextResponse.json({ url: data.signedUrl, expiresInSeconds: SIGNED_URL_EXPIRY_SECONDS });
}
```

`getOwnedMeetingRecording(supabase, meetingId)` called with the **user's own** client (not service-role) is exactly what makes this authorized: if RLS denies visibility, the underlying `.maybeSingle()` returns `null` regardless of whether the row actually exists, and the route correctly returns 404 without ever distinguishing "no recording" from "not your meeting" — the same non-distinguishing-404 pattern `/admin/meetings/[id]/page.tsx` already uses for `notFound()` today, deliberately not leaking existence information to an unauthorized caller.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`

Expected: no errors. If `getSupabaseServiceRoleKey` isn't already exported from `apps/web/env/server.ts`, confirm its exact existing name (used elsewhere tonight in `/api/internal/*` routes) before assuming this name.

- [ ] **Step 3: Lint**

Run: `pnpm --filter web lint`

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/meetings/\[id\]/recording-url/route.ts
git commit -m "feat(recordings): add authorized short-lived playback URL route"
```

---

## Task 10 — Full technical verification

**Files:** none new — this task runs the complete suite across every touched package.

- [ ] **Step 1: Domain package — typecheck, lint, full test suite**

Run: `pnpm --filter @applywizz/domain typecheck && pnpm --filter @applywizz/domain lint && pnpm --filter @applywizz/domain test -- run`

Expected: all clean, all tests pass (275 pre-existing + this plan's new tests).

- [ ] **Step 2: Database package typecheck**

Run: `pnpm --filter @applywizz/database typecheck`

Expected: clean.

- [ ] **Step 3: Web package — typecheck, lint, full test suite, build**

Run: `pnpm --filter web typecheck && pnpm --filter web lint && pnpm --filter web test -- run && (cd apps/web && node_modules/.bin/next build)`

Expected: all clean, all tests pass (44 pre-existing, none of this plan's changes touch existing web tests directly), build succeeds and lists the new `/api/meetings/[id]/recording-url` route.

- [ ] **Step 4: pgTAP**

Run: `docker exec -i supabase_db_AW_otter psql -U postgres -d postgres -f supabase/tests/database/023_meeting_recordings_rls.test.sql`

Expected: `# All tests successful.`

- [ ] **Step 5: Schema drift check**

Run: `supabase gen types typescript --local > /tmp/final-check-types.ts 2>/dev/null && diff <(grep -A30 'meeting_recordings:' packages/database/src/types.ts | head -35) <(grep -A30 'meeting_recordings:' /tmp/final-check-types.ts | head -35)`

Expected: no semantic differences (only formatting, per Task 2's Step 1 finding) — confirms the hand-edited `types.ts` genuinely matches the live schema, not just "looks plausible."

- [ ] **Step 6: Worker smoke — confirm the transcription worker still starts cleanly with the new `storage` dep wired in**

Run: `cd "$(git rev-parse --show-toplevel)" && timeout 15 node_modules/.bin/tsx --env-file=apps/web/.env.local workers/transcription-worker/transcription-worker.mjs 2>&1 | head -5`

Expected: `[transcription-worker] starting, tick every 60000ms, batch size 5` with no `ERR_MODULE_NOT_FOUND` or constructor errors — confirms `supabase.storage.from(...)` resolves correctly as a real object, not just type-compatible on paper.

---

## Task 11 — Real integration verification (human test)

Not automatable — this is the real end-to-end proof against hosted Vexa, matching how every other M17C milestone tonight was actually verified.

- [ ] **Step 1: Real ingestion, triggered by Claude**

Using the same real Teams meeting infrastructure already proven tonight (or a fresh short real meeting), run the real transcription worker against a completed real meeting and confirm via direct database query: a `meeting_recordings` row now exists, `storage_bucket`/`storage_path` are correct, and the Storage object is real (confirm via `storage.info()` against the live bucket, not just the DB row).

- [ ] **Step 2: Prove Vexa independence — the real version of Task 7's unit test**

After Step 1 succeeds, deliberately point `VEXA_API_KEY` at an invalid/expired value (or otherwise make real Vexa calls fail) and re-trigger transcription for the **same** meeting (reset `meeting_transcripts.processing_status` to `pending`). Confirm it still completes successfully — proving the owned copy is genuinely used, not just claimed to be.

- [ ] **Step 3: Real playback URL**

Call `GET /api/meetings/[id]/recording-url` for that meeting as a real authenticated session and confirm the returned signed URL actually plays the real audio.

```
HUMAN TEST — RECORDING PLAYBACK

URL:
http://localhost:3004/meetings/<the real meeting id>

ACTION:
None required for this task's UI — Meeting Detail's own playback UI is
explicitly NOT part of this implementation plan (spec/plan scope is
storage + API only). Claude will fetch the signed URL directly and
confirm it plays via a command-line audio check.

EXPECTED:
Claude reports: real signed URL obtained, real audio downloaded from
it, byte-identical to what's in meeting_recordings.

PASS / FAIL:
```

- [ ] **Step 4: Cross-org denial, for real**

Using a second real (or realistic test-fixture) account in a different organization, confirm `GET /api/meetings/[id]/recording-url` returns 404 for the first org's meeting.

---

## Plan self-review

1. **Every spec requirement mapped to a task:** §5 (schema, no status) → Task 1/2. §6 (storage layout) → Task 1/2. §7 (ingestion flow) → Tasks 3–6. §8 (crash recovery) → Task 5. §9 (authorization) → Task 9. §10 (provider abstraction) → Tasks 2–6 (`source_metadata` isolation). §11 (failure table, all 10 rows) → covered across Tasks 4–9, cross-checked below. §12 (test list A–L) → mapped 1:1 into Tasks 1–9's test steps.
2. **Placeholder scan:** no `TODO`/`TBD`/"handle appropriately"/"similar to previous task" found — every step has real, complete code. One genuine self-correction was found and fixed inline during writing (Task 5's `checksum: "" ` → `checksum: string | null`, corrected in the same step rather than left as a known issue).
3. **Type/name consistency check:** `OwnedRecordingRef`, `RecordingStorageClient`, `ensureOwnedRecording`, `getOwnedMeetingRecording`, `RecordingStorageMismatchError`, `MEETING_RECORDINGS_BUCKET` are each defined exactly once (Tasks 2–6) and referenced identically by name in every later task (7–9) — no drift.
4. **No P3/P4/video/native-bot/self-hosting scope leaked:** confirmed — every task's file map touches only `meeting_recordings`, `meeting-recordings.ts`, `transcription.ts`, and one new API route. Meeting Detail UI is explicitly named as out of scope in Task 11, not silently implemented.
5. **Crash-after-upload-before-DB-write:** Task 5, both tests (match → reconcile, mismatch → fail closed), directly requested and directly covered.
6. **Vexa-unavailable-after-ingestion:** Task 7's primary test asserts zero Vexa endpoint calls when a recording is already owned — not inferred from other assertions, checked directly via a fetch implementation that throws if ever invoked. Task 11 Step 2 repeats this for real.
7. **Cross-org playback denial:** Task 1's pgTAP test #3 (table-level), Task 11 Step 4 (real, route-level).

**Failure-mode → task mapping, explicit:**

| Failure mode | Task | Test |
|---|---|---|
| 1. Vexa says not ready | 4 | "throws RecordingNotReadyError..." |
| 2. Vexa download fails | 4 (implicit — `downloadRecordingMedia` unchanged, already tested in `packages/meeting-bots`) | pre-existing coverage, not duplicated |
| 3. Download OK, Storage upload fails | 4/5 | upload-error branch routes into `reconcilePreexistingObject`, covered by Task 5's tests |
| 4. Upload OK, DB write crashes | 5 | "reconciles without re-uploading..." |
| 5. Retry finds matching object | 5 | same test as #4 |
| 6. Retry finds mismatching object | 5 | "fails closed... when size does not match" |
| 7. Owned object exists, Vexa unavailable | 7 | "does not call any Vexa endpoint..." |
| 8. Transcription fails after ownership | 7/8 (implicit — ownership is untouched by transcription's own retry, no code path connects them) | covered by 7's test re-running unaffected |
| 9. Unauthorized playback attempt | 1, 9 | pgTAP test #3; Task 11 Step 4 |
| 10. Signed URL expires | 9 (design: 600s expiry, browser/caller re-requests) | not unit-testable meaningfully; documented behavior only |

No spec contradiction was found during this review.
