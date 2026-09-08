# ApplyWizz Signal — Post-M6 Product Redesign (v2.0 Delta)

Status: DRAFT for approval. Documentation/architecture only — no code, no migrations, no M7 work started.
Builds on: `docs/product/ApplyWizz_Signal_Complete_Blueprint_v1.pdf` (locked v1.0 PRD/TRD/App
Flow/UX/Schema/Impl Plan, M0–M6 shipped). This document is a **delta**, not a replacement — anything
not mentioned here (org/roles/RLS, Microsoft app-only integration, meeting policy/exceptions,
MeetingBotProvider/Vexa) is unchanged and stays locked.

Verified against the actual repo before drafting: `customers`, `action_items`, `commitments`,
`meeting_decisions`, `intelligence_signals`, `transcripts`, `ai_runs` and every other table the v1.0
schema sketched for M7+ **do not exist yet** — M1–M6 only built org/auth/RLS, people/hierarchy,
Microsoft app-only calendar, canonical meetings + dedupe, meeting policy/exceptions, and
`meeting_bot_jobs`/`meeting_lifecycle_events`. `meetings.meeting_type` exists today as an unused
nullable text column; `meetings.customer_id` does not exist yet. So everything below is genuinely
greenfield — this is a design decision, not a live-data migration.

---

## 1. Updated Product Thesis

> Signal listens to every customer conversation, understands what changed, keeps ApplyWizz's
> customer truth current, and tells the Account Manager what needs to happen next.

Signal is conversation intelligence and persistent customer memory layered on top of the CRM's
lifecycle/scheduling record — not a generic transcription tool, and not a CRM replacement. The v1.0
thesis ("every important customer conversation becomes structured company memory automatically")
stands; this redesign makes "customer" a first-class, CRM-anchored identity instead of an implicit
byproduct of "whoever was on the call," and makes the AM's pre/post-call workflow the primary
interaction surface instead of an admin/compliance console.

Primary V1 user is unchanged: the Account Manager. Admin/Manager/Senior Manager personas from v1.0
are retained and layered on top, per the existing hierarchy.

---

## 2. CRM ↔ Signal Responsibility Matrix

| Concern | System of record | Signal's relationship |
|---|---|---|
| Stable customer ID | **CRM** | Mirrored via `customers.external_crm_id` (read-only sync) |
| Customer identity (name, contacts) | **CRM** | Mirrored into `customers`/`customer_contacts` |
| Assigned Account Manager | **CRM** | Mirrored into `customers.owner_membership_id` |
| Lifecycle stage | **CRM** | Mirrored into `customers.lifecycle_stage`, read-only |
| Onboarding data | **CRM (or onboarding form, see §16 open question)** | Read once to seed Customer Truth V1; not re-synced field-by-field |
| Application start date | **CRM** | Mirrored, display-only |
| Scheduled customer call (type + time) | **CRM** | Mirrored into new `crm_scheduled_calls` (read-only), drives call routing (§3) |
| Subscription/renewal context | **CRM** | Mirrored, display-only |
| Operational application metrics (apps/responses/interviews) | **CRM, where it exists** | Read-only, optional — never fabricated if CRM doesn't track it |
| Meeting identity/linkage | **Signal** | Canonical meeting + link to `customers`/`crm_scheduled_calls` |
| Original + canonical transcript | **Signal** | Owns `transcripts`/`transcript_segments` |
| Structured call intelligence, requirement deltas, commitments, action items, blockers, questions | **Signal** | Owns `call_records`, `customer_truth_facts` |
| Customer memory / relationship history | **Signal** | Derived entirely from Signal's own tables |

### Write-back rule (locked for V1)

**Signal writes nothing back to the CRM automatically in V1.** The CRM stays fully authoritative for
identity/scheduling/lifecycle-stage/subscription; Signal is a strictly additive intelligence layer
keyed by `customer_id`. This is a deliberate simplification: none of the "Customer Truth" fields
(target roles, skills, locations, comp, work auth, resume positioning, etc.) are CRM-owned fields in
the boundary above, so there is nothing safe to write back yet, and no CRM write API has been
designed or authorized. A future CRM write-back (e.g., "mark lifecycle stage advanced") is explicitly
out of scope until a specific field and API contract are approved — this avoids building speculative
write plumbing before it's needed.

The approval workflow the brief asked for still applies, but the "approved change" lands in Signal's
own `customer_truth_facts` ledger, not in the CRM:

```
Signal detects change → proposed Customer Truth delta (status=proposed)
  → AM reviews → confirms or rejects
  → confirmed: new row becomes the current fact for that field (old row stays, superseded)
  → rejected: row kept for audit, excluded from "current" view
```

---

## 3. Meeting/Customer Linkage Strategy (Automatic Call Routing)

Deterministic pipeline, evaluated when a canonical meeting is created/updated (extends the existing
M4 canonical-meeting pipeline — no new webhook source). Never auto-links on low confidence.

**New local mirror:** `crm_scheduled_calls` (org-scoped, one row per CRM scheduled call: external id,
`customer_id`, `assigned_am_membership_id`, `call_type`, `scheduled_start/end`, `status`). This exists
so matching doesn't need a live CRM call per calendar webhook, and so reschedules/cancellations have
a stable key independent of the Teams calendar event.

**Hard pre-filter (applies before any tier below):** a meeting only enters customer-linkage matching
if it already passed M5 policy as `record`-eligible AND has at least one external attendee (outside
the org's own domain). Pure-internal meetings never enter this pipeline.

1. **Tier 1 — CRM scheduled-call match (confidence: high, auto-link).** The canonical meeting's
   organizer/AM + a start time within a tolerance window (±30 min, configurable) of a
   `crm_scheduled_calls` row for a customer owned by that same AM → auto-link, `call_type` comes from
   the CRM row, status = `linked_auto`.
2. **Tier 2 — Attendee-email match (confidence: medium).** No scheduled-call match, but exactly one
   external attendee's email matches a `customer_contacts.email` for a customer owned by the meeting's
   AM → auto-link the customer. `call_type` is sourced from a scheduled call **only** if there is a
   single `crm_scheduled_calls` row for that same customer+AM inside a tight window (±2 hours,
   configurable) of the meeting's start time — never "same day," since a customer can have more than
   one distinct scheduled call on the same day (e.g., Discovery at 10:00, a separate Renewal at 16:00)
   and a wider window risks silently mislabeling the type. Outside that tight window, or if more than
   one scheduled call qualifies, `call_type` is left blank pending explicit AM confirmation. Multiple
   candidate customers → falls through to tier 3.
3. **Tier 3 — `needs_link` (never silent).** No match, ambiguous match, or an AM/owner mismatch (see
   below) → meeting is flagged `needs_link` with ranked suggestions (attendee domain, title text
   similarity — suggestions only, never auto-confirmed). Surfaced as an inbox item to the AM/Admin.
   Bot/transcript/policy processing (M5/M6) proceeds unaffected — customer-context features (Truth,
   portfolio, prep) are simply unavailable until linked.

**Ownership hard filter:** tier 1/2 auto-link only fires when the meeting's organizer/AM equals the
candidate customer's `owner_membership_id`. **V1 has no co-owner concept** — the brief's "account
team"/co-owner idea would need its own permission model and isn't otherwise required, so it's cut
rather than half-built; any owner mismatch always falls to `needs_link` with a visible warning rather
than linking to the wrong AM's customer. This is the mitigation for "wrong participant/calendar
match," and a deliberately simpler rule than "owner or co-owner."

**Out-of-order sync (CRM vs. calendar webhook):** linkage isn't only evaluated when a meeting is
created/updated — a `crm_scheduled_calls` upsert (new or changed row) also enqueues re-evaluation of
that customer's nearby `needs_link`/unlinked meetings, and the same M4-style periodic reconciliation
job that repairs missed calendar notifications also re-runs the linkage pipeline over any meeting
still `needs_link` after its eligibility window has passed. Without this, a calendar webhook that
arrives before the corresponding CRM sync would permanently strand an otherwise-linkable meeting.

**Reschedules:** `crm_scheduled_calls` carries its own stable external id; when the CRM moves the
time for the same id, the existing M4 `calendar_event.changed` → refresh-canonical-meeting path
re-evaluates tier 1 against the same scheduled-call id, preserving the link.

**Cancellations:** CRM marks the scheduled call cancelled → mirrored to `crm_scheduled_calls.status`
→ existing M5/M6 cancellation path fires (bot cancelled if not yet joined) → meeting's link status
set to `cancelled`. No orphaned bot/customer state.

**Duplicate calendar events:** each is its own canonical meeting (correct — they're genuinely distinct
events). If two canonical meetings both tier-1-match the *same* `crm_scheduled_calls` id in the same
window, flag the second as "possible duplicate — same scheduled call already linked" for manual AM/Admin
resolution. Meeting rows are never auto-merged (evidence/transcripts must stay attributable to the
real event).

**Customer has multiple meetings / manual unscheduled call:** matching is per meeting instance, so
multiple legitimate same-day meetings are fine. A manual call with no CRM scheduled-call row falls to
tier 2, or to `needs_link` with the AM prompted to pick from their own portfolio only (never another
AM's customers).

**Missing CRM linkage entirely** (CRM not connected yet, or customer not yet in CRM): meeting is never
dropped — it just stays `needs_link` indefinitely until linkage exists.

---

## 4. Revised M7–M17 Milestone Table

The proposed reordering is technically sound and is kept as given — the key dependency is that call
**routing** (customer identity + call type) must exist before call-type-specific **intelligence** can
be generated, so CRM Foundation must precede the Call Intelligence Engine. One scoping clarification
(not a reorder) is called out below to avoid rework between M12 and M13.

| # | Milestone | Outcome | Gate | Depends on |
|---|---|---|---|---|
| M7 | CRM + Customer Context Foundation | `customers`, `customer_contacts`, `crm_scheduled_calls` synced read-only; meeting↔customer linkage (§3) live | Every eligible meeting is either linked or visibly `needs_link`; zero silent links | M4 (canonical meetings), M5 (policy) |
| M8 | Multilingual Transcript | Original-language transcript + canonical English per segment, EN/Telugu/code-switch | One normalized transcript with speakers, canonical text on every segment | M6 (bot/recording) |
| M9 | Customer Call Intelligence Engine | Call-type-specific structured output (§8), generic action/commitment/decision/question/blocker extraction | Structured, evidence-grounded output validated against per-call-type schema | M7 (call_type known), M8 (transcript) |
| M10 | Customer Truth + Actions | `customer_truth_facts` ledger + `call_records` persisted, AM confirm/reject workflow | AI never silently overwrites; every change traceable to evidence | M9 |
| M11 | Meeting Workspace + Customer/Internal Recap | Internal intelligence view + customer-safe recap email | Recap sends contain zero internal fields (leak test) | M9, M10 |
| M12 | AM Customer Portfolio + Pre-Meeting Prep | Portfolio list (lifecycle stage, renewal-approaching), structured pre-meeting brief | Brief renders from Truth + open `call_records` only — no NL layer required | M10, M11 |
| M13 | Customer Memory + Ask Signal | NL query layer ("Ask This Customer/Meeting") over the same ledger | Grounded answers cite source meetings/evidence | M10, M12 |
| M14 | Manager Intelligence | Concrete `intelligence_signals` types (renewal risk, overdue commitment, repeated complaint, etc.) | Signals evidence-linked, authorization respected | M10, M12 |
| M15 | Audit + Security Hardening | RLS/leak tests for every new table | Deny tests pass | M7–M14 |
| M16 | Reliability + Operations | Retry/backoff, reconciliation for CRM + transcript pipelines | Failure drills pass | M7–M15 |
| M17 | Internal ApplyWizz Pilot | Staged AM rollout | Golden scenarios pass | All above |

**Scoping clarification (M12 vs M13):** "pre-meeting prep" only needs structured retrieval over data
that already exists after M10/M11 (current Truth, open `call_records`, prior recaps) — it does **not**
need a natural-language query engine. Scope M12 to structured/templated retrieval only, and reserve
the NL "Ask Signal" interface exclusively for M13. This avoids building the same retrieval logic
twice and keeps the milestone boundary real rather than cosmetic.

---

## 5. Updated Domain/Entity Model

```
organizations
 └ customers                      [CRM-mirrored identity/lifecycle/owner]
    ├ customer_contacts           [CRM-mirrored]
    ├ crm_scheduled_calls         [CRM-mirrored, NEW]
    ├ customer_truth_facts        [Signal-owned ledger, NEW]
    └ meetings (customer_id, customer_link_status, link_confidence,
                scheduled_call_id, linked_at, linked_by_membership_id)  [extended]
       ├ meeting_attendees        [existing]
       ├ meeting_bot_jobs / meeting_lifecycle_events   [M6, unchanged]
       ├ transcripts / transcript_segments             [extended for §10]
       ├ ai_runs                                       [existing plan, unchanged shape]
       ├ meeting_external_summaries (customer-safe)     [existing plan]
       ├ meeting_internal_intelligence                  [existing plan]
       ├ call_records (action_item|commitment|decision|question|blocker)  [NEW, unified]
       └ intelligence_signals (concrete signal_type values, §11 manager view)
```

**Consolidation decision:** the v1.0 schema sketch had separate `action_items`, `commitments`, and
`meeting_decisions` tables. None of them have been built yet (verified above), and the field list the
brief specifies (description, owner, owner_type, customer_id, lifecycle_stage, source meeting/speaker/
timestamp, due_date, status, dependency, blocks_lifecycle_step, carried_from_prior_meeting,
completed_at, evidence) is identical across action items, commitments, decisions, **and** the two new
types the brief adds (questions, blockers). Building five near-duplicate tables for one shape is
unnecessary; a single `call_records` table with a `record_type` enum covers all five, is easier to
query for "everything outstanding for this customer," and is exactly as strict per-type (state machine
differs by `record_type`, see §9). This is a genuine deviation from the v1.0 schema sketch, called out
explicitly rather than silently diverging, since nothing has been built against the old shape yet.

---

## 6. Customer Truth Schema Concept

Single append-only ledger, not a wide mutable row — the field list is open-ended (locations, comp,
work auth, "other ApplyWizz-specific requirements") and the requirement is to **never destroy history**,
which an EAV-style ledger + a "current" view satisfies without a migration every time a new field is
needed.

```
customer_truth_facts
  id uuid pk
  organization_id uuid
  customer_id uuid fk
  field_key text            -- e.g. target_roles, skills, roles_to_avoid, locations,
                             -- relocation, work_mode, compensation, work_authorization,
                             -- sponsorship, company_preferences, industry_preferences,
                             -- resume_positioning, current_concerns, application_strategy,
                             -- other (free-form key allowed)
  value jsonb               -- shape depends on field_key (string | list | object)
  status enum(proposed, confirmed, rejected, superseded)
  previous_fact_id uuid fk (self) null   -- the fact this one supersedes
  source_meeting_id uuid fk meetings null  -- null for onboarding-form-sourced facts
  source_speaker text null
  evidence_segment_ids uuid[] null
  detected_at timestamptz
  confirmed_by_membership_id uuid null
  confirmed_at timestamptz null
  created_at timestamptz

-- current value per field, read-only view, no separate mutable table:
create view customer_truth_current as
  select distinct on (customer_id, field_key) *
  from customer_truth_facts
  where status = 'confirmed'
  order by customer_id, field_key, confirmed_at desc;
```

Onboarding form ingestion writes directly with `status='confirmed'`, `source_meeting_id=null` — this
is "Customer Truth V1." Every later meeting proposes deltas (`status='proposed'`); AM confirm/reject
is the only path to `confirmed`/`rejected`. Confirming a field sets `previous_fact_id` on the new row
to the prior confirmed fact for that key — nothing is ever updated in place or deleted.

---

## 7. Meeting/Customer Linkage — see §3 above (kept together for flow, cross-referenced here per the
deliverable list).

---

## 8. Call-Type AI Output Contracts

Shared envelope for every `ai_runs` output, validated before persistence (carries forward the locked
v1.0 TRD rule: "structured JSON is validated before AI output is persisted/published"):

```
{
  meeting_id,
  call_type: enum(discovery, resume_review, orientation, day15_progress, renewal) | null,
  call_records: [{ record_type, description, owner_type, owner_ref, due_at?,
                    dependency?, blocks_lifecycle_step?, carried_from_prior_record_id?,
                    evidence_segment_ids }],
  customer_truth_deltas: [{ field_key, previous_value, proposed_value, confidence,
                             evidence_segment_ids }],
  call_type_specific: { ... one of the shapes below, or omitted if call_type is null ... }
}
```

If the meeting is `needs_link` (§3), `call_type` is null and `call_type_specific` is omitted — generic
`call_records`/`customer_truth_deltas` extraction still runs, since it doesn't require knowing the
customer. Call-type-specific analysis is deferred until linkage resolves.

**Every claim-bearing item below is `{ text, evidence_segment_ids }`, never a bare string.** This
applies uniformly — `goals[]` below is shorthand for `goals: [{text, evidence_segment_ids}]`, and so
on for every array in the table. This closes a gap in an earlier draft where only some fields (e.g.
`churn_risk_evidence`) carried evidence and others didn't, which contradicted the success metric in
§14 requiring 100% evidence coverage on `call_type_specific` claims. Non-array status/enum fields
(e.g. `approval_state`, `renewal_decision`) are classifications derived from the whole call, not a
single claim, so they don't carry evidence_segment_ids individually — the record's transcript is the
evidence for those.

| Call type | `call_type_specific` fields (all arrays are `{text, evidence_segment_ids}[]`) |
|---|---|
| **Discovery** | `onboarding_completeness{complete, missing_fields}`, `goals[]`, `constraints[]`, `contradictions_with_onboarding[{field_key, onboarding_value, stated_value, evidence_segment_ids}]`, `new_information[]`, `resume_team_needs[]` |
| **Resume Review** | `resume_changes_requested[]`, `resume_changes_accepted[]`, `resume_changes_rejected[]`, `positioning_changes[]`, `skill_corrections[]`, `role_targeting_changes[]`, `approval_state: approved\|changes_requested\|pending` |
| **Orientation** | `initial_experience_sentiment: positive\|neutral\|negative`, `confusion_points[]`, `application_quality_concerns[]`, `targeting_complaints[]`, `immediate_corrective_actions[]` |
| **Day-15 Progress** | `applications_submitted_count?`, `responses_count?`, `screens_count?`, `interviews_count?` (all null unless CRM provides them — never fabricated), `working[]`, `not_working[]`, `complaints[]`, `strategy_changes[]` |
| **Renewal** | `value_delivered[]`, `unresolved_problems[]`, `objections[]`, `churn_risk_evidence[]`, `renewal_decision: renewed\|not_renewed\|undecided\|pending_customer`, `next_month_strategy[]` |

Preference/requirement changes always flow through the generic `customer_truth_deltas` array, not
duplicated inside `call_type_specific` — one place fields change, regardless of which call surfaced it.

---

## 9. Action/Commitment Lifecycle

Unified `call_records` table (see §5), `record_type` enum: `action_item | commitment | decision |
question | blocker`.

```
call_records
  id, organization_id, meeting_id, customer_id null,
  record_type enum,
  description text,
  owner_type enum(customer, am, resume_team, applywizz, other),
  owner_membership_id null, external_owner_name null,
  source_speaker, source_meeting_id, evidence_segment_ids uuid[],
  due_at null, status enum(...), dependency null,
  blocks_lifecycle_step boolean default false,
  carried_from_prior_record_id uuid fk (self) null,
  completed_at null, created_at, updated_at
```

State machines by `record_type` (status enum is shared but transitions differ):

- **action_item / commitment:** `detected → confirmed → in_progress → completed | cancelled |
  superseded`. `overdue` is a **derived** read (status in `confirmed, in_progress` and `due_at` past),
  never a stored terminal state.
- **decision:** `detected → confirmed | rejected` (a decision is a logged fact, not worked on).
- **question:** `detected(open) → answered | closed`; answering can spawn a follow-up action_item via
  `carried_from_prior_record_id`.
- **blocker:** `detected → confirmed → resolved | cancelled`; sets `blocks_lifecycle_step` when it
  gates progression (e.g., missing work-authorization document blocking Applications Start).

`carried_from_prior_record_id` is what powers memory surfacing: a still-open record reiterated in a
later meeting links forward to the same logical item instead of creating a disconnected duplicate —
this is the mechanism behind "Still outstanding from Discovery."

---

## 10. Multilingual Transcript Contract

Keep one transcript tree per meeting+language+version (existing v1.0 shape), but anchor the canonical
English meaning **at the segment level** rather than as a second parallel transcript — this keeps every
piece of evidence (the same `evidence_segment_ids` used everywhere above) pointing at one row with both
the original and the canonical text, instead of forcing every consumer to join two transcript trees.

```
transcript_segments (existing) + new columns:
  source_language text          -- per-segment, handles code-switching mid-call
  canonical_text text null      -- natural English meaning; null only if not yet processed
  canonical_confidence real null
  needs_review boolean default false   -- low-confidence translation, surfaced for AM/QA
```

Original text is **never overwritten** — `text` stays exactly what was said, `canonical_text` is
always additive. For an English-source segment, `canonical_text` is a straight copy (not re-translated)
so every downstream consumer can always read `canonical_text` uniformly regardless of source language.

Example (matches the brief exactly):

```
segment.text = "Naku Java roles ekkuva vastunnayi. Actually nenu Python backend roles prefer chesthanu."
segment.source_language = "te-en"  (code-switched)
segment.canonical_text = "I'm receiving too many Java roles. I actually prefer Python backend roles."
→ customer_truth_deltas: [{ field_key: "target_roles",
                             previous_value: "Java-heavy roles",
                             proposed_value: "Python/backend roles",
                             evidence_segment_ids: [this segment] }]
```

Low-confidence translations set `needs_review=true` and are excluded from feeding automatic
`customer_truth_deltas`/`call_records` extraction until either confidence improves on reprocessing or
an AM/QA reviewer confirms the segment manually — uncertain translation must not silently become a
confirmed customer fact.

**Segment granularity:** raw ASR/diarization segment boundaries don't reliably line up with a
language switch or a claim boundary — a single segment can contain a Telugu clause and an English
clause with different confidence. Normalization must split a raw segment into finer segments when it
detects a material language or confidence change mid-span (rather than translating a mixed segment as
one unit), so `source_language`/`canonical_text`/`needs_review` stay accurate per claim. This stays
within the single-segment-tree design above — it changes how segments are produced, not the schema.

---

## 11. AM Screen Map (extends v1.0 screen inventory, does not replace it)

| Screen | Change from v1.0 |
|---|---|
| `/home` (AM Home) | Add "Calls today" grouped by `call_type` badge; "Needs attention" feed now includes: missing onboarding info, overdue commitments, resume awaiting approval, unresolved customer issue, renewal approaching, `needs_link` meetings |
| `/meetings/:id` (Upcoming Meeting) | New pre-meeting brief tab: current Customer Truth snapshot, prior unresolved `call_records`, what changed since last call, ApplyWizz/customer promises outstanding, recommended questions, lifecycle-specific agenda |
| `/meetings/:id` (Completed Meeting) | Internal Intelligence tab and Customer-Safe Recap tab shown side by side (RLS unchanged: AM sees internal intelligence for their own meetings only if policy allows, same as v1.0 matrix) |
| `/customers` | Becomes the Portfolio view: grouped by lifecycle stage, renewal-approaching flag, `needs_link` count |
| `/customers/:id` (Customer Memory) | Add "Pending Truth Changes" section requiring AM confirm/reject before anything becomes current |
| `/actions` | Filter by `record_type`, `owner_type`, overdue |

No new customer-facing portal or login — customer-safe recap stays **email-only** in V1, per the
locked v1.0 out-of-scope list ("external customer portal").

## 12. Manager Screen Map (extends v1.0, unchanged routes)

`/manager/overview` and `/manager/intelligence` are re-populated by concrete `intelligence_signals`
types instead of the vaguer v1.0 placeholder ("risks/opportunities/patterns"):

`renewal_risk | overdue_commitment | repeated_complaint | incomplete_discovery | resume_delay |
orientation_issue | weak_day15_outcome`. Portfolio health is a computed rollup, not a stored signal
type. No generic "AM spoke 43%" style surveillance metrics, per the brief's explicit instruction.
`/manager/team/:id`, `/manager/customers`, `/manager/actions` are otherwise unchanged — they already
scope to `call_records`/`customers` via the existing RLS matrix.

---

## 13. Authorization/Privacy Rules

Extends the existing RLS matrix (v1.0 §05.4) with new resources, following the same pattern already
locked for meetings/transcripts:

| Resource | AM | Manager | Senior Manager | Admin |
|---|---|---|---|---|
| `customers` / `customer_contacts` | Own (owner_membership_id) | Direct reports' | Policy | Org-wide |
| `crm_scheduled_calls` | Own | Direct reports' | Policy | Org-wide |
| `customer_truth_facts` (+ `customer_truth_current` view) | Own customers | Direct reports' | Policy | Org-wide |
| `call_records` | Own **meetings** (see note) | Direct reports' meetings | Policy | Org-wide |
| Customer-safe recap email | Sent to customer only; AM/owning chain can view a copy | same | same | same |
| Internal intelligence (incl. `call_type_specific`, churn/risk fields) | Own, if policy | Direct reports | Policy | Org-wide |

**`call_records` visibility is meeting-scoped, not customer-scoped.** `customer_id` on `call_records`
is a denormalized reference for querying "everything outstanding for this customer" — it is not the
access boundary. RLS mirrors the existing M6 pattern exactly (`meeting_bot_jobs_select_meeting_visible`
in `supabase/migrations/20260907030002_meeting_bot_rls.sql`, which inherits meeting visibility via a
nested EXISTS rather than checking ownership directly): a `call_records` row is visible only if its
`source_meeting_id` is a meeting the viewer can already see. Using customer ownership instead would
leak evidence/notes from a source meeting the AM was never authorized to see, just because they own
the customer.

**`customer_truth_current` is a view over `customer_truth_facts` and must not bypass its RLS.** It is
created with `security_invoker = true` (or the equivalent RLS-respecting pattern already used
elsewhere in the schema) so it evaluates policies as the querying role, not the view owner — the same
row-visibility rule as the base table applies, it isn't a separate authorization surface.

No new tables get an authenticated write grant beyond what the AM confirm/reject action requires
(mirrors the M6 pattern: writes are service-role/worker driven except the explicit human
confirm/reject action, which is a narrow, audited RPC — not a raw table UPDATE grant).

---

## 14. Updated PRD Delta

- **Product definition:** unchanged name/tagline; "Category" gains "CRM-anchored customer
  intelligence" alongside the existing "company-controlled meeting intelligence."
- **Product principles:** add — *CRM is authoritative for identity/scheduling; Signal never
  overwrites CRM or customer facts without explicit AM confirmation* (this generalizes and replaces
  the informal write-back assumption absent from v1.0).
- **V1 must-have scope:** add CRM domain (customer/contact/scheduled-call sync, read-only), Customer
  Truth domain, Call Intelligence domain (call-type contracts), Memory/Ask Signal domain — all as
  described above, folded into the existing table structure at §01.6 of v1.0.
- **Success metrics:** add — `≥95%` of eligible customer meetings auto-linked at tier 1/2 (rest
  correctly flagged `needs_link`, never silently mislinked); `0` **AI-meeting-detected**
  `customer_truth_facts` reach `confirmed` without an explicit AM review action (onboarding-form-sourced
  facts are confirmed by construction — filling out the form *is* the human action, there is no AI
  inference step for them, so they're excluded from this metric rather than being an exception to it);
  `100%` of `call_type_specific` claim fields carry `evidence_segment_ids` (see §8).
- **Golden path (updated):** `Admin adds AM → CRM sync creates customer + scheduled call → AM's
  Teams meeting auto-links (tier 1) → bot joins (M6) → multilingual transcript → call-type
  intelligence → Customer Truth deltas proposed → AM confirms → internal/customer recap → manager
  signals updated`.

## 15. Updated TRD/Architecture Delta

- **New provider abstraction:** `CRMProvider` (adapter pattern, same shape as `MeetingBotProvider`):
  `listCustomers()`, `getCustomer(externalId)`, `listScheduledCalls(cursor)`. Read-only in V1 — no
  `updateCustomer`/write methods exist yet; adding one later is an explicit, separately-approved
  change, not an extension point built speculatively now.
  `FakeCRMProvider` follows the same test-double pattern as `FakeMeetingBotProvider`.
- **New tables:** `customers`, `customer_contacts`, `crm_scheduled_calls`, `customer_truth_facts` (+
  `customer_truth_current` view), `call_records`, `transcripts`/`transcript_segments` (extended per
  §10). `intelligence_signals` gets concrete `signal_type` values (§12).
- **Extended table:** `meetings` gains `customer_id`, `customer_link_status`, `link_confidence`,
  `scheduled_call_id`, `linked_at`, `linked_by_membership_id`.
- **Architecture rules carried forward unchanged:** modular monolith + async workers; provider IDs
  never leak into core domain/UI; every side effect idempotent; structured JSON validated before
  persistence; privileged credentials server-side only.
- **New rule:** AI-detected `customer_truth_facts` and `call_records` are written with
  `status='detected'/'proposed'` by the AI pipeline and can **only** transition to
  `confirmed`/`in_progress`/`completed` via an explicit AM-authenticated action — no service-role or
  worker path ever auto-confirms one.

---

## 16. Risks / Open Questions

1. **BLOCKING — CRM identity is unknown.** This document designs `CRMProvider` as a generic adapter,
   but M7 cannot actually be implemented without knowing which CRM ApplyWizz uses, its API/auth
   model, and — critically — **whether it exposes a "scheduled call" object with a call type at all**.
   A fallback design for "CRM has customers but no scheduled-call/call-type concept" is now specified
   in §17 (M7 step 1) rather than treating this purely as a precondition that blocks all downstream
   work — routing degrades gracefully to tier 2 + AM-confirmed call type, and M8 (transcript) proceeds
   in parallel regardless of the answer, since it only depends on M6.
2. **Onboarding form source is unspecified.** Is it a new ApplyWizz-built form Signal ingests
   directly (webhook/API), or an existing external tool requiring manual entry into Signal? Determines
   whether "Customer Truth V1" ingestion is an integration or a data-entry screen.
3. **Real transcription is not yet enabled.** M6's Vexa deployment runs with `TRANSCRIBE_ENABLED=false`
   (no GPU provisioned). M8 (multilingual transcript) requires either GPU provisioning on the existing
   Azure VM or a different STT pipeline for Telugu/code-switching — an infra cost decision, not
   assumed here.
4. **Day-15 operational metrics may not exist in CRM.** `call_type_specific` fields for application/
   response/interview counts are modeled as always-optional; if CRM never provides them, Day-15 output
   simply omits them rather than fabricating numbers.
5. **M12/M13 scoping** — see the clarification under §4; not blocking, just needs to be respected
   during implementation to avoid rebuilding retrieval logic twice.
6. **Schema consolidation deviation** — §5's `call_records` table replaces the v1.0 sketch's three
   separate tables. Called out explicitly per the v1.0 doc's own rule ("update the document first
   rather than silently changing architecture"); safe because nothing has been built against the old
   shape yet.

---

## 17. Proposed M7 Implementation Plan (plan only — no code)

**M7 — CRM + Customer Context Foundation**

1. **Decision gate (blocking, short — not an open-ended discovery task):** confirm which CRM, its
   API/auth model, and whether it exposes a scheduled-call/call-type object.
   - **If yes:** proceed with steps 2–10 as written — tier 1 routing (§3) is fully available.
   - **If no (CRM has customers/contacts but no scheduled-call concept):** `crm_scheduled_calls` is
     not populated from CRM at all; routing degrades to tier 2 only (attendee-email match), and
     `call_type` is **always** left for explicit AM confirmation on first contact with a given meeting
     series rather than inferred — there's no CRM signal to infer it from. Everything else in §3–§9 is
     unchanged; only the tier-1 auto-link and its call-type inference are unavailable until/unless the
     CRM later adds that concept.
   - Either way, this gate does not block M8 — multilingual transcript only depends on M6 and proceeds
     in parallel.
2. Define `CRMProvider` interface (read-only: `listCustomers`, `getCustomer`, `listScheduledCalls` —
   the last one returns an empty/unsupported result under the "no" branch above rather than the
   interface changing shape).
3. Implement `FakeCRMProvider` for tests, mirroring `FakeMeetingBotProvider`'s contract-fidelity
   approach, with a fixture for both the "has scheduled calls" and "no scheduled calls" branches.
4. Create `customers`, `customer_contacts`, `crm_scheduled_calls` tables + RLS (same pattern as
   M6's `meeting_bot_jobs`/`meeting_lifecycle_events`: org-scoped select via nested EXISTS, no
   authenticated write grant beyond service-role/worker); `call_records`'s RLS instead inherits
   meeting visibility per §13, not customer visibility.
5. Extend `meetings` with `customer_id`, `customer_link_status`, `link_confidence`,
   `scheduled_call_id`, `linked_at`, `linked_by_membership_id` + an org-consistency trigger matching
   the one added for M6's bot tables.
6. Implement the CRM sync worker (poll/webhook per the resolved provider, cursor-based, idempotent)
   populating `customers`/`customer_contacts`/`crm_scheduled_calls`; every upsert enqueues linkage
   re-evaluation for that customer's nearby `needs_link` meetings (§3's out-of-order-sync fix).
7. Implement the linkage pipeline (§3) as a pure domain function over canonical meetings +
   `crm_scheduled_calls`, invoked both from the existing M4 `calendar_event.changed` handoff and from
   step 6's CRM-upsert trigger; add it to the periodic reconciliation job alongside the existing
   missed-calendar-notification repair.
8. Build the `needs_link` inbox surface (minimal — a filtered list, not a new screen system) for
   AM/Admin manual resolution.
9. pgTAP: RLS allow/deny for all new/extended tables (including a `call_records` deny test proving
   customer ownership alone does not grant access without meeting visibility); linkage-pipeline unit
   tests covering every scenario in §3 (reschedule, cancel, duplicate event, multi-meeting day with a
   too-wide inference window, manual call, wrong-AM mismatch, missing CRM link, CRM-sync-before-webhook
   and webhook-before-CRM-sync ordering, and the "no scheduled-call concept" branch from step 1).
10. Golden-path verification: under whichever branch step 1 resolves to, a real customer's real Teams
    meeting auto-links (tier 1 if available, tier 2 + AM-confirmed type otherwise) with no silent
    mislink — this milestone's equivalent of M6's real-bot-join acceptance bar.

---

## Codex Review

See `/private/tmp/claude-501/-Users-ramakrishnachanda-Desktop-AW-otter/e511db15-94c3-430a-9fbf-4a90c064d9c2/scratchpad/codex-post-m6-redesign-review.md`
for the full independent review and resolution log (appended after drafting).
