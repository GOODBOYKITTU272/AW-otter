# ApplyWizz Signal

> Schedule the meeting normally. ApplyWizz handles everything else.

Company-controlled meeting intelligence and organizational memory for ApplyWizz account managers. See [`docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf`](docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf) for the approved PRD, TRD, App Flow, UI/UX Brief, Backend Schema and Implementation Plan — that document is the source of truth for product and architecture decisions.

## Status

**Active Development — Milestones M0–M17 Complete, P3/P4 Enhancements Shipped.**  
The product has advanced significantly beyond initial foundation work. Current features include:
- ✅ Auth, calendar sync (Microsoft Graph), meeting bot orchestration (Vexa)
- ✅ Transcription stack (Azure MAI primary, OpenRouter fallback, speaker identity, integrity checks)
- ✅ Meeting intelligence (summaries, action items, customer truth proposals)
- ✅ Echo grounded chat with trust/safety guardrails
- ✅ Role-based UI (Admin, Manager, Account Manager)
- ✅ Production-ready workers, security hardening, operational monitoring

See `docs/product/` for milestone plans and `CODE_HEALTH_REVIEW.md` for current codebase status.

## Prerequisites

- Node.js >= 22.13
- [pnpm](https://pnpm.io) (version pinned in `package.json#packageManager`; run via `corepack enable` or install directly)

## Install

```bash
pnpm install
```

## Local environment configuration

Copy `.env.example` to `apps/web/.env.local` and fill in the values you need for the feature you're working on. Never commit real secrets — `.env*` files (except `.env.example`) are gitignored.

Client-safe variables (`NEXT_PUBLIC_*`) are read via `apps/web/env/client.ts`. Every other variable is server-only and read via `apps/web/env/server.ts`, which refuses to execute if it's ever imported into browser code.

## Commands

Run from the repository root (fans out to every workspace package):

```bash
pnpm dev         # start the web app
pnpm typecheck   # tsc --noEmit across all packages
pnpm lint        # eslint across all packages
pnpm test        # vitest across all packages
pnpm build       # production build across all packages
pnpm format      # prettier --write .
```

## Repository architecture

```
apps/
  web/                 Next.js + React + TypeScript app (role-aware UI)
packages/
  domain/               Core business types and rules, provider-agnostic
  database/             Supabase client + generated types
  auth/                 Auth/session/role resolution
  microsoft/            Microsoft Graph calendar integration
  meeting-bots/         MeetingBotProvider abstraction (Vexa adapter)
  transcription/        Transcription providers (Azure MAI, OpenRouter, benchmarking)
  ai/                   AI providers (OpenRouter intelligence, Ask Signal, Echo trust)
  crm/                  CRM integration (ApplyWizz customer details API)
  scheduler/            ApplyWizz scheduler API integration
  email/                EmailProvider abstraction (reserved for M17D — not yet implemented)
  observability/        Logging, metrics, audit helpers (reserved — not yet implemented)
workers/
  orchestrator/         Bot orchestration worker (meeting bot lifecycle)
  transcription-worker/ Transcription processing worker (audio → text pipeline)
supabase/
  migrations/           SQL migrations (source of truth schema)
  tests/                Database-level RLS/allow-deny tests (pgTAP)
docs/
  product/              Milestone plans and product specifications
  transcription/        Transcription stack TRDs (P3A-P3F)
  echo/                 Echo trust and grounding specs (P4A)
  ops/                  Operational runbooks and production setup
  security/             Security audit findings and remediation
```

ApplyWizz PostgreSQL (via Supabase) is the system of record. Microsoft, Vexa, Azure MAI, OpenRouter, and the ApplyWizz CRM/scheduler are external providers accessed through explicit adapter interfaces — never hard-coded into core domain types.
