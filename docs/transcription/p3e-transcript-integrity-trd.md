# P3E Technical Requirements Document: Transcript Integrity & Hallucination Guardrails

## 1. Context & Objectives
- **Milestone**: P3E (Transcript Integrity & Hallucination Guardrails)
- **Product Law**:
  - *AI CAN PROPOSE. EVIDENCE CANNOT BE REWRITTEN. HUMANS APPROVE WHAT LEAVES THE COMPANY.*
  - Transcript Integrity serves as **Quality Truth (Gate 3)** in Apply Wizz Signal.
  - Raw audio evidence and raw diarized transcript segments are permanent and immutable.
  - The integrity subsystem evaluates the fidelity of the transcript evidence, detecting model hallucination loops, background media bleed, speech gaps, and low model confidence.

## 2. Invariant Rules
1. **Evidence Immutability**:
   - Integrity evaluation does NOT edit, truncate, or rewrite `transcript_segments`.
   - Integrity reports and flags are strictly additive audit records in `meeting_integrity_reports` and `meeting_integrity_flags`.
2. **Deterministic Quality Classification**:
   - **Good**: Audio and transcript pass all confidence and loop thresholds.
   - **Needs Review**: Flags detected that warrant AM inspection before finalizing recap.
   - **Suspected Background Media**: Non-speech / TV / YouTube / background music tokens detected.
   - **Poor Audio / Insufficient Speech**: Extremely short duration or zero transcribeable dialogue.
   - **Transcription Unreliable**: Critical repetition loops or severe model breakdown detected.
3. **Detection Heuristics**:
   - **Repetitive Loop Artifacts**: Known Whisper/Azure STT hallucination tokens (e.g., "Amara.org", "Subtitles by", "Thank you for watching", "Please subscribe", "Bell icon").
   - **In-Segment Repetition Loops**: Identical token/phrase loops within a single segment (e.g., "the the the" or "yeah yeah yeah").
   - **Cross-Segment Consecutive Loops**: Same phrase repeating across multiple consecutive segments.
   - **Media Bleed**: Standard media tokens (e.g., `[music]`, `[applause]`, `♪`, `♫`).
   - **Silence/Speech Gaps**: Unusually long gaps (>20s) between consecutive speech segments.
   - **Low Model Confidence**: Segments with confidence < 0.40.
4. **AM UI & Approval Transparency**:
   - Integrity verdicts are surfaced directly on the Meeting Detail and Recap views.
   - Flagged segments highlight the exact time range and reason code, alerting the Account Manager before client-facing recap submission.
