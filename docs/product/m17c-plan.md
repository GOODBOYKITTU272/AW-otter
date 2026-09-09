# M17C — Hosted Vexa Golden Path

**Status:** PLAN — not yet approved, not yet implemented.

## Why this file exists (supersedes the M17C section in `m17-plan.md`)

`m17-plan.md`'s original M17C section ("Microsoft/Vexa real integration
smoke") was written when the working assumption was a self-hosted Vexa
deployment. That assumption is reversed for this checkpoint: **we now have
a Vexa Pay-as-you-go hosted account and a real Bot API key.** M17C uses
hosted Vexa. Self-hosted Vexa, Azure infrastructure, local
Whisper/Parakeet, and diarization are explicitly out of scope here — they
remain a possible *later* decision, made only after hosted Vexa has proven
(or failed to prove) the golden path in production.

This file is the authoritative M17C plan. `m17-plan.md`'s M17C section
should be treated as superseded once this plan is approved.

## The one outcome

```
Real Microsoft Teams meeting
  → hosted Vexa bot joins
  → meeting captured, transcript reaches Signal
  → existing Signal intelligence pipeline runs
  → transcript, summary, actions, and Customer Truth proposals
    are visibly available in Signal
```

Nothing else. No live copilot, no new dashboards, no new provider
abstractions, no customer-facing email, no Phase 2 work.

## What already exists and gets reused untouched

- `packages/meeting-bots`'s `MeetingBotProvider` interface and its
  `VexaMeetingBotProvider` implementation — provider-agnostic by design;
  this is exactly the abstraction that makes "point it at a hosted account
  instead of a self-hosted one" a config change, not a rewrite.
- `workers/orchestrator/bot-worker.mjs` — polls
  `reconcileOrganizationMeetingBots` / `processPendingBotJobs` /
  `syncBotStatuses`, unchanged.
- `workers/transcription-worker/transcription-worker.mjs` (M17B) — polls
  `enqueuePendingTranscriptions` / `processTranscriptionQueue` from
  `@applywizz/domain/transcription`, unchanged. This is the process that
  downloads Vexa's recorded audio, transcodes it with `ffmpeg`
  (`packages/domain/src/audio-transcode.ts`), and sends it to OpenRouter's
  Whisper backend for the actual transcript.
- The existing meeting-intelligence pipeline (summary / actions /
  Customer Truth proposals) — fires off the resulting transcript exactly
  as it does today; nothing about M17C changes what happens after a
  transcript exists.

## Verified: where transcription actually happens today (no double-build risk)

Read directly from the current implementation, not assumed:

- `packages/meeting-bots/src/vexa/client.ts`'s `createBot()` sends
  `transcribe_enabled: false` on every `POST /bots` call — hardcoded, not
  conditional. Vexa's own transcription feature is explicitly turned off
  for every bot this codebase has ever created, hosted or self-hosted.
- `packages/meeting-bots/src/vexa/recordings.ts` only ever downloads raw
  recorded **audio** (`GET /recordings/{id}/media/{mediaFileId}/download`)
  — never a transcript endpoint.
- The transcription worker (`@applywizz/domain/transcription`) is the
  **only** place a transcript is produced: it takes that downloaded audio,
  transcodes it locally, and calls OpenRouter's Whisper backend.

So today there is exactly one transcription path (OpenRouter), and it is
already the only one wired up. Vexa's hosted API separately confirms
(`docs.vexa.ai`, fetched live) that transcription defaults to *enabled*
at the deployment level unless a request overrides it — which is exactly
what this codebase's explicit `transcribe_enabled: false` already does.

**For M17C: keep `transcribe_enabled: false` exactly as it is.** That one
line is the entire guarantee against accidentally paying for or building
a second transcription path. No code change needed here — this is a
verification finding, not a task.

## Unreconciled discrepancy — verify empirically, do not assume either way

`client.ts`'s `createBot()` sends:

```json
{ "platform": "teams", "meeting_url": "<teams-join-url>", "bot_name": "...", "transcribe_enabled": false }
```

Vexa's current published docs for `POST /bots` (fetched live from
`docs.vexa.ai/api/meetings`) show `platform` + `native_meeting_id` as the
required fields, and describe `meeting_url` as something `POST /meetings`
(a separate, *planned*-meeting endpoint) parses server-side into
`platform` + `native_meeting_id` — not a field `POST /bots` itself
documents accepting.

This codebase's own comment claims the `meeting_url`-direct shape was
"confirmed against docs.vexa.ai/api/meetings" when M6 built this — so
either the docs changed since, the comment was wrong from the start, or
`POST /bots` accepts `meeting_url` as an undocumented convenience on top
of the documented shape. I don't know which, and I'm not going to guess.

**This is the first thing to verify in M17C, before anything else in the
golden-path test:** point the existing, unmodified `createBot()` at the
real hosted endpoint and see what actually happens.

- If it succeeds: the discrepancy is moot, note it in the code comment as
  "verified working against hosted Vexa on `<date>`," done.
- If it 422s expecting `native_meeting_id`: the minimum fix is parsing
  the `native_meeting_id` out of the Teams join URL ourselves (`platform`
  is already hardcoded to `"teams"`) and sending that instead of
  `meeting_url`. That would be a small, targeted change to `createBot()`
  only — not a provider redesign, not touched until this is confirmed
  necessary.

No code changes are made for this until the real API call is actually
made and the result is known.

## Minimum configuration change

Because the provider abstraction already exists and the auth mechanism is
identical between hosted and self-hosted Vexa (`X-API-Key` header, no
prefix-based differentiation — the `vxa_bot_...` key format is just
Vexa's own naming convention for the same header value), the only change
M17C needs is configuration, not code:

| Variable | Current (dev/self-hosted assumption) | M17C (hosted) |
|---|---|---|
| `VEXA_BASE_URL` | `http://localhost:18056` | `https://api.cloud.vexa.ai` |
| `VEXA_API_KEY` | dev/self-hosted key | the real hosted Bot API key |

**Where the real key goes — human action, not something I do for you:**
local testing uses `apps/web/.env.local` (already gitignored — verify
`git check-ignore apps/web/.env.local` prints the path before pasting
anything into it); production uses whatever secret store the hosting
platform provides (per `docs/ops/production-secrets-checklist.md` from
M17A). Never the chat, never a file committed to the repo, never
`vercel.json` or any other tracked config file.

## Explicit exclusions for M17C

Self-hosted Vexa, Azure VM, local Whisper, Parakeet, diarization
infrastructure, a custom ApplyWizz meeting bot, new dashboards, live
copilot, Phase 2 work, a new provider abstraction, and customer-facing
auto-email. None of these are touched, discussed as "while we're at it,"
or partially started during M17C.

## Steps

1. Set `VEXA_BASE_URL` / `VEXA_API_KEY` for local testing per the table
   above (human action).
2. Run the existing `bot-worker.mjs` and `transcription-worker.mjs`
   locally (or against the M17B production deploy, once §"Human test"
   below is ready) pointed at hosted Vexa — no code deployed differently
   than M17B already ships.
3. Real Teams meeting, real invite, bot joins — this is where the
   `meeting_url` vs `native_meeting_id` question above gets answered for
   real. Fix `createBot()` only if the real call actually fails, per the
   minimum fix already described.
4. Confirm the recording downloads, transcodes, and reaches OpenRouter
   exactly as the existing transcription worker already does for any
   other recording — no special-casing for "hosted" anywhere past
   `createBot()`, since everything downstream only ever sees a
   provider-agnostic recording reference.
5. Confirm meeting-intelligence runs and produces a visible transcript,
   summary, actions, and Customer Truth proposals in Signal.

**Automated tests:** existing CI (typecheck/lint/test/pgTAP/build) must
stay green. No new test framework — this checkpoint is a real-endpoint
smoke test of already-tested code, plus (only if step 3 requires it) one
small regression test for the `native_meeting_id`-parsing fallback.

## Human test

```
URL: <production APP_BASE_URL>/integrations
Login: a real ApplyWizz account (yours or a designated internal test account)
Action: connect your own Microsoft calendar, then create a real Teams
        meeting with yourself and one colleague a few minutes out
Expected: within a couple minutes of the meeting starting, a bot with the
          configured display name joins the Teams call

URL: <production APP_BASE_URL>/meetings/<the test meeting>
Login: same account
Action: wait for the meeting to end, then wait a few minutes and reload
Expected: a transcript, a summary, action items, and any Customer Truth
          proposals are visible on the meeting's page
Reply PASS/FAIL for each
```

All technical verification (API call succeeded, worker picked up the
job, transcription completed, intelligence ran) stays with Claude —
the human test above is only the two visible checks.

**Rollback:** unset `VEXA_API_KEY` (existing §9 pattern from
`m17-plan.md`) — clean no-op, no bots get created, nothing partially
in-flight to clean up.

**Definition of done:** one real bot join against real Teams via the
hosted Vexa account, real transcript produced via the existing OpenRouter
path, real meeting-intelligence run completes, transcript/summary/
actions/Customer Truth all visibly present in Signal for that one
meeting, full CI gate green.

## Explicitly not started

M17D (internal recap email) does not start until M17C is confirmed
shipped and the user says so.
