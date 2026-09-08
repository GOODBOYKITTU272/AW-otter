# ApplyWizz Signal — M7 Integration Readiness (No CRM Access Yet)

Status: DRAFT for approval. Documentation/architecture only — no code, no migrations, no M7 work
started. Supersedes the CRM-linkage-related parts of `docs/product/Signal_Post_M6_Redesign_v2.md`
(§2–§9, the M7 rows of §4/§17) for as long as real CRM API access is unavailable; everything else in
v2 (Customer Truth ledger shape, call-type AI contracts, multilingual transcript, action/commitment
lifecycle, screen maps, authorization pattern) is unchanged and still applies.

---

## 1. CRM Current State

**Fact: real CRM API access is not available yet.** Everything below is explicitly UNKNOWN — not
researched, not guessed, not assumed — and stays unresolved until access arrives:

- CRM vendor/API, authentication model
- Customer object shape, contact object shape
- Assigned-AM field, lifecycle/stage field
- Application start date, subscription/renewal fields
- Scheduled-call/appointment object, call type field
- Webhook support, rate limits
- External ID format, reschedule/cancel behavior

These are documented as unresolved external dependencies (§9), not designed around by guessing. No
CRM vendor name appears anywhere in this repo, so none of the above is inferred from existing code.

---

## 2. Temporary M7 Strategy

M7 splits into two milestones:

- **M7A — Customer Context Foundation without CRM API.** Signal owns a minimal customer directory
  itself, seeded manually/via fixtures, sufficient to unblock meeting linkage, call-type confirmation,
  and Customer Truth — all without a live CRM.
- **M7B — Real CRM Adapter, built after API access arrives.** Populates the fields CRM actually owns
  and reconciles them onto the M7A-created customer rows (§9) — it does not replace or migrate the
  M7A schema.

M7A must stand on its own (AMs get real value: linked meetings, confirmed call types, a growing
Customer Truth ledger) and must not create anything M7B would need to tear down. The load-bearing rule
that keeps this true: **every M7A concept is additive and nullable, never a stand-in that mimics a
CRM field.** `external_crm_id` is null until the real CRM says otherwise; nothing else pretends to be
a CRM value.

---

## 3. M7A Customer Model (Signal-owned, temporary)

```
customers
  id uuid pk                          -- the only ID anything else references
  organization_id uuid fk
  external_crm_id text null           -- NULL until M7B backfills it; never a manual/fake value
  name text
  owner_membership_id uuid fk         -- assigned Account Manager
  lifecycle_stage text null           -- unknown until CRM available
  source_type enum(manual, fixture, future_import)   -- how THIS ROW was created
  created_by_membership_id uuid null  -- who manually created it, if source_type=manual
  created_at timestamptz
  updated_at timestamptz

customer_contacts
  id uuid pk
  customer_id uuid fk
  email citext
  name text null
  created_at timestamptz
```

`source_type` on `customers` here is a distinct concept from Customer Truth's own `source_type`
(§7/§8) — this one is "how did this customer record come to exist," that one is "how did this fact
come to exist." Keeping them separate avoids overloading one enum with two different questions.

**Hard rule:** nothing in M7A ever writes a manual/temporary value into `external_crm_id`. A
Signal-created customer's stable identity, for as long as no CRM exists, is its own `id` — every
meeting, `call_record`, and `customer_truth_fact` references `customers.id`, never `external_crm_id`.
This is exactly what lets M7B attach the real CRM ID later without touching any existing foreign key.

---

## 4. Meeting ↔ Customer Linkage Without CRM

Only one automatic tier exists now — there is no CRM scheduled-call signal to form a higher-confidence
tier from (unlike v2's tier 1, which assumed at least CRM read access). This tier is exactly v2's old
"tier 2," promoted to be the sole automatic path:

**Rule:** meeting organizer is a managed AM (`owner_membership_id`) **and** exactly one external
attendee's email matches a `customer_contacts.email` for a customer owned by that same AM.

- **Exactly one match → auto-link** (`linked_auto`).
- **Zero matches → `needs_link`.**
- **Multiple matches → `needs_link`.**
- **AM ownership conflict** (the matched contact's customer belongs to a *different* AM than the
  meeting organizer) **→ `needs_link`.**

**Constraint that makes "exactly one match" trustworthy:** `customer_contacts` has a unique constraint
on `(organization_id, email)` — one contact email belongs to exactly one customer, enforced at the
database, not just assumed. Without this, a shared/generic address (a recruiter, a vendor, an advisor
who emails on behalf of more than one ApplyWizz customer) stored as a contact under Customer A would
auto-link a meeting that's actually about Customer B, as long as it matched "exactly one" row by
accident of which customer got that contact entered first. If the same real-world email genuinely
needs to be associated with more than one customer, that's a manual data problem for an Admin to
resolve deliberately — not something the auto-link rule should paper over.

Title text similarity and email-domain similarity are **never** used to make an automatic link
decision — they may only appear as ranked suggestions on the `needs_link` screen (§6) for a human to
act on.

---

## 5. Call Type Without CRM

No CRM scheduling data exists, so call type is **never inferred** — not from meeting title, not from
date/timing, not from AI transcript content, not from attendee names. For every linked meeting, the
AM explicitly confirms exactly one of: `discovery | resume_review | orientation | day15_progress |
renewal | other_unknown`.

Persisted on the meeting:

```
call_type enum(discovery, resume_review, orientation, day15_progress, renewal, other_unknown) null
call_type_source enum(am_confirmed, external)   -- always am_confirmed until M7B (or any other
                                                 -- future source) exists
confirmed_by_membership_id uuid
confirmed_at timestamptz
```

`external` deliberately isn't named `crm` — the CRM's actual call-type support is itself one of the
unknowns in §1, and M7B may turn out to source call type from a scheduler, an imported file, or
nothing at all. Using a generic `external` value now avoids a second enum change if the concrete
source turns out not to be a CRM scheduled-call object. This is fully auditable (who confirmed, when)
and requires no schema change either way — the v2 §8 call-type AI contract envelope already keys off
`call_type` alone and doesn't care where it came from, so M9 (Customer Call Intelligence) needs no
rework when the source eventually flips from `am_confirmed` to `external`.

---

## 6. `needs_link` Workflow

Meeting linkage state, five values: `linked_auto | linked_manual | needs_link | unlinked | cancelled`.

For a `needs_link` meeting, show: the meeting, organizer, scheduled time, external attendees,
suggested customers (ranked by attendee-domain and title-text similarity — suggestions only, per §4),
and the reason automatic matching failed (zero matches / multiple matches / ownership conflict).

The AM (or Admin) can:

- **Choose an existing customer** from their own portfolio → `linked_manual`.
- **Create a new temporary customer** directly from this screen — this is explicitly in scope for
  M7A, since Signal owning a minimal customer directory is the entire point of this milestone. The
  new row gets `source_type='manual'`, `created_by_membership_id` = the acting AM/Admin,
  `external_crm_id=null` → `linked_manual`.
- **Leave unlinked** (`unlinked`) — meeting keeps its bot/transcript/policy processing; customer
  features stay unavailable.
- **Correct an existing link** (re-point to a different customer) — this is also audited, same as a
  fresh link.

Every one of the four actions above — link, create+link, leave unlinked, correct — writes an
`audit_events` row (actor, action, entity, timestamp), with no exception for "leave unlinked" just
because it's the least eventful choice; it's still a deliberate human decision about a meeting the
system couldn't resolve on its own, and later needs the same traceability as an active link would.
This matches the audit pattern already locked in v1.0's TRD reliability rules.

**Visibility follows the owner, not the creator:** an Admin creating or linking a customer on an AM's
behalf still sets `owner_membership_id` to that AM — RLS for `customers`/`customer_contacts` (v2 §13)
scopes strictly by `owner_membership_id`, so an Admin-created row is only "owned" by whoever it's
assigned to, never implicitly visible as the Admin's own customer.

---

## 7. Onboarding Form

The onboarding-form source is unknown, so **no onboarding integration is built now** — building one
against a guessed shape would be exactly the kind of speculative work this phase exists to avoid.
Customer Truth seeding stays provider-agnostic via a `source_type` field on each fact:

```
source_type enum(onboarding_form, manual, crm, future_import, meeting)
```

For development/testing, only fixture/manual seed data is used. When the real onboarding source is
known later, integrating it is an adapter/importer that writes rows with `source_type='onboarding_form'`
into the *existing* ledger shape — not a second onboarding system and not a Customer Truth redesign.

---

## 8. Customer Truth (unchanged ledger, generalized source)

The append-only ledger approved in v2 §6 is unchanged in shape; `source_type` (§7) replaces the
narrower "source_meeting_id null ⇒ onboarding" implication from v2 with an explicit field:

```
customer_truth_facts
  id, organization_id, customer_id, field_key, value,
  status enum(proposed, confirmed, rejected, superseded),
  previous_fact_id null,
  source_type enum(onboarding_form, manual, crm, future_import, meeting),
  source_meeting_id null (set only when source_type='meeting'),
  source_speaker null, evidence_segment_ids null,
  detected_at, confirmed_by_membership_id null, confirmed_at null, created_at
```

**Rule (unchanged from v2, restated for this ledger's new sources):** onboarding-form and manual seed
facts may be written `status='confirmed'` directly at ingestion — the human act of entering that data
*is* the confirmation, there's no AI inference step to gate. **AI-detected facts from a meeting
(`source_type='meeting'`) always start `status='proposed'`** and can only become `confirmed`/`rejected`
via an explicit AM action. AI never silently changes current Customer Truth, regardless of which
source_type populated the ledger historically.

---

## 9. Future M7B CRM Adapter (designed now, not built)

`CRMProvider` stays the abstraction already designed in v2 §15 — read-only, adapter pattern:
`listCustomers()`, `getCustomer(externalId)`, `listScheduledCalls(cursor)`. **Not implemented now.**

The one new design problem M7B must solve that v2 didn't need to: **reconciling CRM customers against
customers M7A already created manually.** Plan (design only):

1. M7B's sync worker fetches CRM customers and, for each, attempts a match against existing Signal
   `customers` rows via contact-email overlap (a CRM contact email matching a `customer_contacts.email`
   already on file) — the same trustworthy signal §4 already uses for meeting linkage, reused here for
   identity reconciliation instead.
2. **Confident match (exactly one Signal customer, no existing `external_crm_id`):** backfill
   `external_crm_id` onto the *existing* Signal customer row — same `id`, so every meeting,
   `call_record`, and `customer_truth_fact` already linked to it stays linked with zero migration.
   **Never overwrite a non-null `external_crm_id`** — a match against a row that already has a
   *different* CRM id means the contact-email signal was wrong (a shared address, a duplicate row) and
   must go to Admin reconciliation (below), not silently reassign.
3. **No match:** create a new `customers` row normally, `source_type='future_import'`.
4. **Ambiguous match:** surface to Admin for manual reconciliation — the same never-guess-silently
   posture as `needs_link`, applied to customer identity instead of meeting linkage. "Ambiguous"
   covers more than "multiple Signal candidates for one CRM customer": it also covers a CRM customer
   that plausibly corresponds to two *different* existing Signal rows that should be **merged**, and a
   single Signal row that plausibly corresponds to two *different* CRM customers and should be
   **split**. None of these are auto-resolved — a merge/split changes which meetings and
   `customer_truth_facts` a customer's `id` represents, which is exactly the kind of decision this
   design keeps out of automatic code paths. Every reconciliation decision (backfill, merge, split, or
   "these are genuinely different, leave separate") is an audited Admin action.

This is exactly the mechanism that fulfills "must not create architecture that later fights the real
CRM": the CRM becomes authoritative for `external_crm_id`/identity/lifecycle-stage/scheduling the
moment it's reconciled, without disturbing anything Signal already built on top of that customer's
`id`. **No CRM write-back** in M7B either — unchanged from v2's locked decision; Signal remains
authoritative for meeting linkage, transcripts, evidence, call intelligence, Customer Truth history,
and all `call_records` (action items/commitments/blockers/questions/decisions/memory).

---

## 10. Roadmap Impact

| # | Milestone | Depends on |
|---|---|---|
| M7A | Customer Context Foundation without CRM API | M4 (canonical meetings), M5 (policy) |
| M7B | Real CRM Adapter (built when API access arrives) | M7A |
| M8 | Multilingual Transcript | M6 only — **not blocked by CRM access at all** |
| M9 | Customer Call Intelligence | M7A (customer identity + AM-confirmed call_type is sufficient — does not need M7B) + M8 |
| M10 | Customer Truth + Actions | M9 |
| M11 | Meeting Workspace + Recaps | M9, M10 |
| M12 | AM Portfolio + Pre-Meeting Prep | M10, M11 |
| M13 | Customer Memory + Ask Signal | M10, M12 |
| M14 | Manager Intelligence | M10, M12 |
| M15 | Security | M7A–M14 |
| M16 | Reliability | M7A–M15 |
| M17 | Internal Pilot | All above |

M7B can slot in whenever real CRM access actually arrives — it has no downstream dependents of its own
(M9 depends on M7A, not M7B), so the rest of the roadmap never stalls waiting for it.

**Caveat on M12's "no M7B needed" claim:** this only holds because M12's portfolio/lifecycle-stage/
renewal-approaching display (v2 §11) must degrade cleanly when the underlying CRM-owned fields are
null — M7A leaves `customers.lifecycle_stage` unknown/null, and subscription/renewal context is one of
§1's unresolved unknowns. M12's implementation must treat those fields as optional display data (e.g.,
"lifecycle stage: unknown" rather than a broken widget), not assume they're populated. This is a
requirement on M12's build, not a reason to move it after M7B.

---

## Codex Review

See `/private/tmp/claude-501/-Users-ramakrishnachanda-Desktop-AW-otter/e511db15-94c3-430a-9fbf-4a90c064d9c2/scratchpad/codex-m7-readiness-review.md`
for the full independent review and resolution log.
