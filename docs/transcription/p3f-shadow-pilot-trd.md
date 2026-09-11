# P3F Technical Requirements Document: Real Apply Wizz Shadow Pilot

## 1. Context & Objectives
- **Milestone**: P3F (Real Apply Wizz Shadow Pilot)
- **Product Law**:
  - *AI CAN PROPOSE. EVIDENCE CANNOT BE REWRITTEN. HUMANS APPROVE WHAT LEAVES THE COMPANY.*
  - The Shadow Pilot framework allows evaluating primary STT (Azure MAI) against secondary fallback (Whisper/OpenRouter) on real meeting recordings without mutating primary transcripts or polluting downstream customer/recap workflows.

## 2. Invariant Rules
1. **Zero Production Mutation**:
   - Shadow evaluation runs must NOT modify or overwrite primary `transcript_segments`, `meeting_transcripts`, or `meeting_recaps`.
   - Primary outputs remain the sole source of truth for AM recap generation and approval.
2. **Audit Logging & Provenance**:
   - Shadow comparison results are captured additively in `public.audit_events` under action `transcription.shadow_evaluated`.
   - Metadata records provider models, primary vs shadow WER/similarity, speaker count delta, latency delta, and integrity verdict correlation.
3. **Deterministic Comparison Metrics**:
   - **Text Agreement & Divergence**: Normalized token alignment (Levenshtein distance & WER).
   - **Diarization Consistency**: Comparison of identified unique speaker counts and segment alignments.
   - **Quality Guardrail Correlation**: Verifying that integrity warnings flagged on primary are also analyzed on shadow.
   - **Latency & Reliability**: Exact duration of transcription pipeline for primary vs shadow.
4. **Tenant Isolation**:
   - Shadow evaluations are strictly scoped by `organization_id` and respect database RLS.
