# Recording Ownership Design (P2)

> Status: DESIGN ONLY — not implemented. No migration exists yet. No storage code exists yet. This document is the thing being reviewed before any of that is written.

## 1. Problem

Signal does not persist its own copy of a meeting's recorded audio. Confirmed by inspection (`packages/domain/src/transcription.ts`): `processTranscriptionJob` downloads the raw recording from Vexa into a temp directory, transcodes it, transcribes it, and deletes both the raw and transcoded files in a `finally` block — every time, success or failure. Confirmed further by an exhaustive repo-wide search: there is zero Supabase Storage usage anywhere in this codebase today.

Consequence: the only place the audio exists, ever, is on Vexa's own servers. If Vexa deletes a recording (retention policy, account change, outage) after we've already transcribed it, the transcript survives but the source evidence it was built from does not. A transcript is a *derived* artifact; without the original, it can never be re-verified, re-processed with a better model, or played back by an AM.

## 2. Scope / non-scope

**In scope:** persisting one owned, immutable copy of the original recorded **audio** per meeting, in ApplyWizz-controlled storage; transcription reading from that copy instead of Vexa; authorized playback of that copy from Meeting Detail.

**Explicitly not in scope** (per direct instruction, not to be touched by this work or its implementation):
- Video recording, camera capture, or shared-screen capture of any kind
- An FFmpeg video pipeline
- A native Microsoft Teams recording bot
- Self-hosted Vexa or any DigitalOcean work
- Multilingual/code-switch transcription changes (P3)
- Any AM dashboard or navigation redesign (P4)
- M17D
- A retention/deletion policy subsystem (see §11)
- A second job-queue/retry subsystem (see §3)

## 3. Existing architecture (what this reuses, unchanged)

- **`packages/meeting-bots/src/vexa/recordings.ts`** — `getMeetingRecordingRef` (now correctly using `GET /recordings?meeting_id=`, fixed earlier tonight) and `downloadRecordingMedia` (`GET /recordings/{id}/media/{id}/download`). Both reused **as-is**. Real, confirmed response shape from tonight's live testing includes `file_size_bytes` and `format` per media file — this is real data this design leans on, not assumed.
- **`packages/domain/src/transcription.ts`** — `processTranscriptionJob`'s retry/backoff mechanics (`MAX_RETRY_COUNT`, `retryBackoff`, `classifyError`, `meeting_transcripts.retry_count`/`next_retry_at`/`error_code`). **This is the retry system P2 reuses — no second one is being built.**
- **Existing idempotency idiom, used twice already in this codebase** (`syncMeetingBotIntent` in `meeting-bots.ts`, `enqueuePendingTranscriptions` in `transcription.ts`): insert optimistically, treat a `23505` unique-violation as "someone else already did this, not an error." P2's `meeting_recordings` insert uses the exact same idiom.
- **`meeting_transcripts`' actual RLS policy** (read directly from the live schema): `meeting_transcripts_select_meeting_visible` is a single `EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_transcripts.meeting_id)` — it does **not** duplicate org/manager-scope logic; it relies on `meetings`' own RLS policies being evaluated inside that subquery for the querying user. This is the pattern P2's authorization reuses (§9).

## 4. Chosen architecture — Option B, `meeting_recordings`

Recording ownership is a distinct domain concern from transcription: it has its own lifecycle (must exist *before* transcription can even start, per the target flow), its own distinct failure modes (a Storage upload failing is a different problem than a Whisper call failing), and its own metadata shape (byte size, checksum, storage path — nothing to do with transcription). A dedicated table keeps `meeting_transcripts` from absorbing an unrelated concern, and keeps each table's retry/error fields meaning exactly one thing.

## 5. Schema (proposed — no migration written yet)

```
meeting_recordings
  id                 uuid primary key
  organization_id    uuid not null references organizations(id)
  meeting_id         uuid not null references meetings(id)
  storage_bucket      text not null
  storage_path        text not null
  content_type         text not null
  byte_size            bigint not null
  duration_seconds     numeric nullable
  checksum_sha256       text nullable
  source_provider        text not null   -- 'vexa'
  source_metadata          jsonb not null default '{}'
  captured_at                timestamptz nullable
  created_at                   timestamptz not null default now()
  updated_at                      timestamptz not null default now()

  unique (organization_id, meeting_id)
```

### No `status` column — deliberate, explained

The brief asked me to determine this from the actual ingestion sequence rather than default to one. Answer: **not needed.** There is no separate job state machine here (per §3's constraint) — `ensureOwnedRecording` (§7) is called *inline*, inside the existing `processTranscriptionJob`, and if any step of it fails, it simply `throw`s up into the transcript's own existing `catch` block, which already does full retry/backoff classification. On the next transcript retry, `ensureOwnedRecording` is called again from scratch. There is never a persisted "in-progress" state to represent, because nothing about this design holds a claim across process restarts the way `meeting_bot_jobs.status = 'scheduled'` does — **a row's mere existence *is* the state.** No row → not yet owned. Row present → owned, confirmed, done. This is also why no `retry_count`, `claim_token`, or lease state exists on this table: retry ownership stays entirely with `meeting_transcripts`, per direct instruction.

### `source_metadata` contents (provider-specific, hidden from AM UI)

```json
{
  "recordingId": 556922936300,
  "mediaFileId": 559299580948,
  "nativeMeetingId": "19:meeting_...@thread.v2",
  "platform": "teams",
  "sourceFileSizeBytes": 474476,
  "sourceFormat": "webm"
}
```

`sourceFileSizeBytes`/`sourceFormat` are Vexa's own reported values (from `GET /recordings`) at ingestion time — kept alongside our own `byte_size`/`content_type` specifically so a crash-recovery reconciliation (§8) has something to validate the pre-existing Storage object against without re-downloading it.

### `duration_seconds` — honestly nullable, not populated in P2

Vexa's own `media_files[].duration_seconds` was `null` in tonight's real response — Vexa doesn't reliably report it. Probing the *raw*, untranscoded file with `ffprobe` has not been verified to work in this codebase (only the *transcoded* output has been proven probeable, via `probeAudioFile` after `transcodeToOpusOgg`). Rather than assume raw-file probing works, P2 leaves `duration_seconds` null at ingestion time. Backfilling it from the transcription stage's own probe is a trivial, separate follow-up, not required for P2 to be correct.

## 6. Storage layout

- **Bucket:** `meeting-recordings`, private (no public access). First Storage bucket ever created in this project — no existing convention to conform to or break.
- **Path:** `organizations/{organization_id}/meetings/{meeting_id}/original.{ext}` — `{ext}` taken from Vexa's real reported format (`webm` in every real test tonight); deterministic and reconstructable from `organization_id`+`meeting_id` alone, which is exactly what makes the crash-recovery check in §8 possible without needing to query anything first.

## 7. Ingestion / data flow

```
processTranscriptionJob(transcript, deps):
  botJob = fetch meeting_bot_jobs row            # unchanged, already does this
  { recordingRef, bytes } = ensureOwnedRecording(serviceRoleClient, transcript, botJob, deps.vexaEnv, deps.fetchImpl)
  workDir = mkdtemp()
  write raw bytes to workDir                      # unchanged from here down
  transcode -> probe -> transcribe -> normalize -> complete_transcription_job RPC
  finally: delete workDir                          # unchanged — the OWNED copy in
                                                     # Storage is never touched here
```

```
ensureOwnedRecording(supabase, transcript, botJob, vexaEnv, fetchImpl):
  existing = SELECT * FROM meeting_recordings WHERE meeting_id = transcript.meeting_id
  if existing:
    bytes = Storage.download(existing.storage_bucket, existing.storage_path)   # service-role, no signing needed for a backend read
    return { recordingRef: existing, bytes }

  # Not owned yet.
  vexaMeetingId = botJob.provider_metadata.id                       # same numeric id already used tonight's fix
  vexaRecording = getMeetingRecordingRef(vexaEnv, vexaMeetingId)     # existing function, unchanged
  if !vexaRecording: throw RecordingNotReadyError                   # existing error, existing retry classification

  path = `organizations/${orgId}/meetings/${meetingId}/original.${ext}`

  preexisting = Storage.getMetadata(bucket, path)   # cheap existence+size check, no download
  if preexisting:
    # Crash-recovery case (§8) — we did NOT just upload this ourselves.
    if preexisting.size == vexaRecording.sourceFileSizeBytes
       and preexisting.contentType matches expected:
      row = INSERT meeting_recordings (... , source_metadata) ON CONFLICT (organization_id, meeting_id) DO NOTHING
      row = row ?? (SELECT * FROM meeting_recordings WHERE meeting_id = ...)   # lost the insert race — someone else just reconciled it
      bytes = Storage.download(bucket, path)
      return { recordingRef: row, bytes }
    else:
      throw RecordingStorageMismatchError   # FAIL CLOSED — never overwrite

  # Nothing at the path at all — real fresh ingestion.
  bytes = downloadRecordingMedia(vexaEnv, vexaRecording.recordingId, vexaRecording.mediaFileId, fetchImpl)   # existing function, unchanged
  checksum = sha256(bytes)
  uploadResult = Storage.upload(bucket, path, bytes, { contentType, upsert: false })
  if uploadResult.error == "already exists":
    # Race: another concurrent attempt uploaded between our check and our upload.
    # Same reconciliation path as the crash-recovery branch above.
    <repeat the preexisting-validation branch>
  else if uploadResult.error:
    throw   # real upload failure — existing transcript retry/backoff handles it

  row = INSERT meeting_recordings (org, meeting, bucket, path, content_type, byte_size, checksum_sha256, source_provider: 'vexa', source_metadata, captured_at)
         ON CONFLICT (organization_id, meeting_id) DO NOTHING
  row = row ?? (SELECT * FROM meeting_recordings WHERE meeting_id = ...)
  return { recordingRef: row, bytes }
```

## 8. Idempotency and crash recovery

The exact scenario named in review — object uploads successfully, then the process crashes *before* the `meeting_recordings` row commits — is handled by the `preexisting` branch in §7: on retry, `ensureOwnedRecording` finds no DB row, computes the same deterministic path, finds an object already sitting there, and **validates it against Vexa's own reported size/format before trusting it.** Match → reconcile (insert the row, done, no re-upload). Mismatch → fail closed, never overwrite, surface a distinct, visible `RecordingStorageMismatchError` (which — being a real, non-transient problem — will exhaust `MAX_RETRY_COUNT` and land the transcript in `failed` with a clear `error_code`, not loop silently forever).

`upsert: false` on the actual upload call is a second, independent safety net against the narrower race where two concurrent ingestion attempts both pass the `preexisting` check as "nothing there yet" and both try to upload at nearly the same instant — one wins, the other's upload call itself fails with "already exists" and falls into the same reconciliation branch.

The DB insert itself uses the established `ON CONFLICT DO NOTHING` / re-select idiom already used twice elsewhere in this codebase — the `unique (organization_id, meeting_id)` constraint is what actually guarantees at most one row ever exists, regardless of how many concurrent callers raced to get there.

## 9. Authorization / playback

New route: `GET /api/meetings/[id]/recording-url`.

Exact authorization path — reusing the existing pattern, not inventing a parallel one:

1. Route runs with the **requester's own authenticated Supabase client** (same as every other route in this app — `getSupabaseServerClient()`).
2. It queries `meeting_recordings` (or simply checks `meetings` visibility directly) using that client. Because `meeting_recordings`' own RLS policy will mirror `meeting_transcripts_select_meeting_visible` exactly — `EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_recordings.meeting_id)` — the real authorization decision (org scope, manager-scope, role) is made by `meetings`' *own* existing RLS policies, evaluated transitively inside that `EXISTS`. Nothing new to reason about — if the user couldn't see the meeting, they can't see the recording row either, automatically.
3. Only if that query returns a row does the route switch to a service-role client purely to call `Storage.createSignedUrl(bucket, path, expiresInSeconds: 300..600)` and return *only* that URL.
4. The service-role key never reaches the browser. The signed URL is the only thing that does, and it expires in 5–10 minutes.

## 10. Provider abstraction

`MeetingBotProvider` is untouched — P2 doesn't add, remove, or change any of its methods. `meeting_recordings.source_provider = 'vexa'` plus `source_metadata` (jsonb) is where every Vexa-specific detail (`recordingId`, `mediaFileId`, `nativeMeetingId`) lives — nothing Vexa-shaped leaks into the table's top-level columns, and nothing in `source_metadata` is ever shown in normal AM-facing UI (Technical Details stays admin-only, same convention as Meeting Detail already uses tonight).

## 11. Failure handling

| # | Scenario | Persisted state | Retry behavior | User-visible? | Vexa contacted again? |
|---|---|---|---|---|---|
| 1 | Vexa says recording not ready | no `meeting_recordings` row | existing transcript backoff retries the whole job | "Transcript is still processing" (existing copy) | Yes, next attempt |
| 2 | Vexa download fails | no row | existing transcript backoff | existing failure copy | Yes, next attempt |
| 3 | Download OK, Storage upload fails | no row (upload never committed) | existing transcript backoff | existing failure copy | Yes — re-downloads (no partial reuse for a genuinely failed upload) |
| 4 | Upload OK, DB insert crashes | object exists, no row | next attempt hits the `preexisting` reconciliation branch — **no re-upload, no re-download** | none, resolves silently on retry | No |
| 5 | Retry sees object present & matching | reconciled row created | proceeds straight to transcription | none | No |
| 6 | Retry sees object present & mismatching | no row, fails closed | exhausts retries → `failed`, distinct error_code | transcript shows a real failure, not silently stuck | No — deliberately does not trust it |
| 7 | Stored recording exists, Vexa later unavailable | row already exists | transcription retries read only from our Storage | unaffected | **No — this is the point of P2** |
| 8 | Transcription fails after recording safely stored | row untouched | transcript retries; `ensureOwnedRecording` fast-path returns instantly | existing transcript failure copy, recording unaffected | No |
| 9 | Unauthorized user requests playback URL | n/a | n/a | RLS-gated query returns nothing → route returns 403/404 | No |
| 10 | Signed URL expires | n/a | AM re-requests from Meeting Detail, gets a fresh one | playback fails, page can silently re-fetch | No |

## 12. Testing strategy

The implementation plan (once approved) must include, at minimum:

- **A.** Successful first ingestion — row created, correct fields, bytes match what was downloaded
- **B.** Storage path is exactly the deterministic convention in §6
- **C.** Two concurrent ingestion attempts for the same meeting produce exactly one Storage object and one DB row
- **D.** Upload succeeds, then a simulated crash before the DB insert; a second `ensureOwnedRecording` call reconciles without re-uploading or re-downloading
- **E.** An object exists at the deterministic path with a size that does *not* match Vexa's reported size → fails closed, no row created, no overwrite
- **F.** Once a row exists, a subsequent call makes **zero** calls to any Vexa endpoint (`getMeetingRecordingRef`/`downloadRecordingMedia` both unused) — proves the "Vexa becomes unavailable" requirement directly, not just by inference
- **G.** `processTranscriptionJob` actually transcribes the bytes returned by `ensureOwnedRecording`, not a fresh Vexa download
- **H.** A user from a different organization cannot get a signed URL for this meeting's recording (RLS)
- **I.** The temp work directory used for transcoding is still deleted in every case (unchanged existing behavior — regression-only)
- **J.** The owned Storage object is **never** deleted by any part of this flow
- **K.** A genuinely failed upload never results in a `meeting_recordings` row existing — no false-positive "owned" state
- **L.** The playback route requires real, RLS-passing meeting access before returning any signed URL — never a bare/public one

## 13. Future exclusions (explicitly out of scope, not designed here)

Video/camera/screen capture, FFmpeg video pipeline, native Teams bot, self-hosted Vexa, DigitalOcean, multilingual transcription (P3), AM dashboard (P4), M17D, and — separately from all of those — a **retention/deletion policy**. P2's actual policy for this phase is simply: no automatic overwrite, no automatic deletion, no user-facing delete feature. This is not "store forever" as a designed guarantee; it is "we do not build deletion in P2," and a real retention policy (likely compliance-driven) remains a distinct future decision.

---

## Self-review

- **Contradictions:** none found — the "no status field" decision is consistent throughout (§5, §7, §8 all rely on row-existence-as-state, nowhere does another section assume a status value exists).
- **TBD/placeholders:** none — every field, path, and error code named is concrete, not a stand-in.
- **Ambiguous state transitions:** the two reconciliation entry points (§7's `preexisting` branch and the upload-race branch) were originally two different code paths in an earlier draft; merged into one described branch since they do the same validation — removed that ambiguity.
- **Unnecessary complexity:** deliberately did *not* add `retry_count`/`claim_token`/status to `meeting_recordings`, per direct instruction and because the existing transcript-level retry already covers it — checked this doesn't quietly reintroduce a second state machine anywhere else in the flow, and it doesn't.
- **Provider leakage:** `source_metadata` is the only place Vexa-shaped fields exist; confirmed §10 states this explicitly and Meeting Detail's existing admin-only Technical Details convention (already built tonight) is the natural home for ever surfacing it.
- **Missing crash/retry cases:** cross-checked the failure table (§11) against all 10 scenarios requested — all present. Test list (§12) covers all 10 plus B/G/I/J which were implied but not explicitly numbered in the request.
