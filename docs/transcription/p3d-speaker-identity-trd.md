# P3D Technical Requirements Document: Speaker Identity & Business Role Interpretation

## 1. Context & Objectives
- **Milestone**: P3D (Speaker Identity + Business Role Interpretation)
- **Product Law**:
  - Raw provider evidence is immutable. If Azure/Whisper says `Speaker 0`, Signal must always show that the provider originally said `Speaker 0`.
  - Identity and business role mapping are strictly additive interpretation layers.
  - The three concepts must remain permanently separate:
    1. **DIARIZATION**: Raw provider tag (e.g. `Speaker 0`)
    2. **IDENTITY**: Interpreted person/user reference (e.g. `ramakrishna@applywizz.ai`)
    3. **BUSINESS ROLE**: Discrete business role (`AM` | `CANDIDATE` | `OTHER` | `UNKNOWN`)

## 2. Invariant Rules
1. **Raw Evidence Immutability**: `transcript_segments` rows (`speaker_label`, `original_text`, etc.) are never mutated by interpretation.
2. **Additive Storage**: Interpretations are stored in `meeting_speaker_interpretations` keyed by `(organization_id, meeting_id, raw_speaker_tag)`.
3. **Deterministic Evidence Hierarchy**:
   - Explicit self-identification in transcript (e.g. "This is [AM] from Apply Wizz", or addressing the counterparty).
   - Meeting attendee roster & calendar organizer linkage.
   - CRM customer linkage (`meetings.customer_id`).
   - Speaker order is **never** used as identity proof (`Speaker 0` is NOT forced to `AM`).
   - `UNKNOWN` is a fully supported first-class outcome when evidence is ambiguous or missing.
4. **Auditable Human Correction**:
   - An authorized human (AM owner, manager, admin) can correct attribution without altering raw diarization.
   - Human corrections set `confirmed_by_human = true`, lock against automated re-evaluation overwrite, and emit structured audit events to `audit_events`.
5. **Tenant Isolation & RLS**:
   - `meeting_speaker_interpretations` is protected by RLS inheriting meeting visibility and reporting hierarchy.
