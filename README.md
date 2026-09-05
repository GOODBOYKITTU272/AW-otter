# ApplyWizz Signal

> Schedule the meeting normally. ApplyWizz handles everything else.

Company-controlled meeting intelligence and organizational memory for ApplyWizz account managers. See [`docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf`](docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf) for the approved PRD, TRD, App Flow, UI/UX Brief, Backend Schema and Implementation Plan — that document is the source of truth for product and architecture decisions.

## Status

**Milestone M0 — Repository & Development Foundation.** Only the app shell, tooling and CI exist. No auth, calendar, bot, AI, email or CRM behavior yet — see the Implementation Plan in the blueprint for build order.

## Prerequisites

- Node.js >= 20
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
  meeting-bots/         MeetingBotProvider abstraction (Vexa adapter first)
  ai/                   AIProvider abstraction (OpenAI first)
  email/                EmailProvider abstraction
  crm/                  CRMProvider abstraction (ApplyWizz CRM adapter)
  observability/        Logging, metrics, audit helpers
workers/
  orchestrator/         Durable queue workers for async pipeline stages
supabase/
  migrations/           SQL migrations (source of truth schema)
  functions/             Supabase edge functions, if any
  tests/                 Database-level RLS/allow-deny tests
docs/
  product/               Product blueprint (PRD/TRD/App Flow/UX/Schema/Plan)
  architecture/          Architecture decision notes
  runbooks/              Operational runbooks
tests/
  e2e/                   End-to-end tests
```

`packages/*` and `workers/orchestrator` are currently empty placeholders — they're populated milestone by milestone per the Implementation Plan (Person → Calendar → Policy → Bot → Transcript, before AI/email/CRM).

ApplyWizz PostgreSQL (via Supabase) is the system of record. Microsoft, Vexa, OpenAI, email and CRM are external providers accessed through explicit adapter interfaces — never hard-coded into core domain types.
