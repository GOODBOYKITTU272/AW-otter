# Apply Wizz Signal

> **Schedule the meeting normally. Apply Wizz handles everything else.**

Apply Wizz Signal is an internal Microsoft Teams meeting-intelligence system for Apply Wizz Account Managers. It captures company-owned meeting evidence, turns conversations into grounded summaries and customer-truth proposals, and keeps a human approval step before important information becomes trusted business data.

The product is not intended to be a generic note-taking bot. Its core flow is:

```text
Microsoft Teams
  → meeting discovery
  → recording policy
  → self-hosted Vexa bot
  → company-owned recording
  → transcription
  → transcript integrity
  → speaker interpretation
  → AI meeting intelligence
  → AM review
  → approved Customer Truth
```

## Product principle

> **AI can propose. Evidence cannot be rewritten. Humans approve what leaves the company.**

Signal keeps three layers separate:

1. **Raw evidence** — original recording, transcript, provider speaker labels, timestamps, provider provenance.
2. **Interpretation** — speaker identity, business role, summaries, extracted facts, integrity analysis.
3. **Approved business truth** — AM-approved recap and confirmed Customer Truth.

## Current status

The repository is far beyond the original M0 foundation described in the old README.

### Implemented on `main`

- ✅ Organization, authentication, roles, hierarchy and Supabase RLS
- ✅ Microsoft Graph connection, calendar discovery and canonical meeting records
- ✅ Recording policy and do-not-record controls
- ✅ Vexa meeting-bot lifecycle and hosted/self-hosted adapter path
- ✅ Company-owned immutable meeting recordings
- ✅ Secure recording playback
- ✅ Production transcription abstraction
- ✅ Azure MAI transcription provider
- ✅ OpenRouter Whisper transcription provider
- ✅ Fallback/retry infrastructure and provider-attempt history
- ✅ Speaker diarization interpretation / business-role layer
- ✅ Transcript integrity and hallucination guardrails
- ✅ Shadow-pilot evaluation framework
- ✅ AI meeting intelligence, summaries and action items
- ✅ Customer Truth proposal / confirm / reject flow
- ✅ AM recap review and approval gate
- ✅ Manager/admin role-aware visibility
- ✅ Echo grounded Q&A / trust controls
- ✅ Orchestrator and transcription workers
- ✅ Production scheduling, health and security hardening

### Production-readiness work still in progress

- 🟡 Make Azure MAI the explicitly verified deployed production primary
- 🟡 Add Sarvam Saaras:v4 to the live production provider chain
- 🟡 Prove Azure → Sarvam → Whisper fallback end-to-end
- 🟡 Prove integrity `FAIL` hard-blocks downstream AI on every path
- 🟡 Verify deployed workers, Graph, Vexa and provider secrets in the real runtime
- 🔴 Run 3–5 real Teams meetings through the complete golden path
- 🔴 Run the 1–2 AM internal pilot
- 🔴 Expand to the initial 7-AM team only after pilot evidence is good

> Production-readiness work is tracked separately from already-shipped product capabilities. Do not treat unmerged readiness branches as part of `main`.

## Initial rollout target

The first internal launch is intentionally narrow:

```text
1–2 Account Managers
  → real Microsoft Teams meetings
  → self-hosted Vexa
  → Azure MAI primary transcription
  → Sarvam Indic fallback
  → Whisper safety fallback
  → integrity gate
  → speaker interpretation
  → AI recap / Customer Truth proposals
  → AM review and approval
```

After the small pilot is stable, expand to the initial **7 Account Managers**.

Not required for the first internal launch:

- live copilot
- Zoom / Google Meet
- mobile app
- sentiment scoring
- public sharing
- external customer portal
- advanced analytics
- full CRM auto-write
- automatic customer email

## Transcription strategy

The current approved provider direction is:

| Role | Provider | Purpose |
| --- | --- | --- |
| Primary | Azure MAI-Transcribe-2 | General meeting transcription, diarization, word timestamps, code-switch support |
| Indic specialist / fallback | Sarvam Saaras:v4 | Hindi, Telugu and Indian-language/code-mixed speech |
| Safety fallback | OpenRouter Whisper Large-v3-Turbo | Very low-cost operational fallback |

The provider layer is intentionally abstracted so cloud/provider decisions do not leak into core domain rules.

## Meeting bot

Signal uses Vexa through the `MeetingBotProvider` abstraction.

The intended production model is **self-hosted Vexa**, not per-bot-hour hosted Vexa SaaS. The application only depends on the configured Vexa endpoint and API key; recording evidence is copied into Apply Wizz-owned storage and becomes independent of Vexa after ingestion.

## Roles

### Admin

Company-wide operations, meetings, team hierarchy, policies, integrations, provider health, audit and incidents.

### Manager

Visibility into permitted AMs and meetings, pending reviews, quality issues and team operations without impersonating AM approval.

### Account Manager

Upcoming meetings, meeting evidence, transcript, recap, action items, Customer Truth review and approval.

## Repository architecture

```text
apps/
  web/                    Next.js + React + TypeScript role-aware application

packages/
  domain/                 Core business rules and golden-path orchestration
  database/               Supabase client and generated database types
  auth/                   Authentication, sessions and role resolution
  microsoft/              Microsoft Graph / Teams calendar integration
  meeting-bots/           MeetingBotProvider abstraction and Vexa adapter
  transcription/          Azure / OpenRouter providers and transcription tooling
  ai/                     Meeting intelligence and grounded AI providers
  crm/                    Apply Wizz CRM integration
  scheduler/              Scheduling integration
  email/                  Reserved / future email provider surface
  observability/          Reserved / evolving operational tooling

workers/
  orchestrator/           Meeting-bot and async orchestration worker
  transcription-worker/   Audio preprocessing and transcription worker

supabase/
  migrations/             PostgreSQL schema source of truth
  tests/                  pgTAP RLS / security tests

docs/
  product/                Product and milestone specifications
  transcription/          Transcription design / benchmark documentation
  echo/                   Echo trust and grounding documentation
  ops/                    Production and operational runbooks
  security/               Security reviews and hardening notes

tests/
  e2e/                    End-to-end test surfaces
```

Supabase/PostgreSQL is the system of record. Microsoft, Vexa, transcription providers, AI providers and CRM services are accessed through explicit adapters rather than being embedded into core domain types.

## Local prerequisites

- Node.js >= 22.13
- pnpm (version pinned in `package.json#packageManager`)

Enable Corepack if required:

```bash
corepack enable
pnpm install
```

## Local environment

Copy the example environment file:

```bash
cp .env.example apps/web/.env.local
```

Fill only the values required for the feature you are working on.

**Never commit real secrets.**

Client-safe variables use `NEXT_PUBLIC_*`. Server-only configuration must remain on the server and must not be exposed to browser bundles.

## Common commands

Run from the repository root:

```bash
pnpm dev         # start development
pnpm typecheck   # TypeScript checks
pnpm lint        # ESLint
pnpm test        # Vitest
pnpm build       # production build
pnpm format      # Prettier
```

## Evidence and security rules

Do not:

- overwrite an owned original recording
- rewrite completed raw transcript evidence
- map `Speaker 0` directly to a business role inside immutable evidence
- allow a failed transcript to silently create trusted Customer Truth
- commit customer audio or private transcripts
- expose provider secrets to the browser
- bypass organization RLS
- silently erase provider fallback history

## Source-of-truth documents

Product and architecture decisions are documented under `docs/product/`, `docs/transcription/`, `docs/echo/`, and `docs/ops/`.

The historical blueprint is available at:

[`docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf`](docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf)

When the blueprint and the implemented repository diverge, verify the current code and the latest approved milestone/PR before assuming an old status statement is still true.

## Current focus

The priority is no longer to build another large feature set.

The priority is to prove the existing system in the real environment:

**one real Teams meeting → owned evidence → trustworthy transcription → grounded intelligence → human approval**

and then repeat it reliably for the initial Apply Wizz AM cohort.
