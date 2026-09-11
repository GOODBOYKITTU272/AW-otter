# P3C Technical Requirements Document: Fallback & Provider Reliability

## 1. Context & Objectives
- **Milestone**: P3C (Fallback + Provider Reliability)
- **Primary Provider**: Azure MAI-Transcribe-2 (`azure-mai`)
- **Indic Specialist / Fallback**: Sarvam (`sarvam`)
- **Safety Fallback**: OpenRouter Whisper Large-v3-Turbo (`openrouter`)

### Core Law
- **ONE MEETING SHOULD PRODUCE ONE ACCEPTED TRANSCRIPT EVIDENCE SET.**
- Provider retries and fallback attempts must NEVER create duplicate immutable transcript segments.
- Do NOT build arbitrary 30-second multi-provider stitching. A transcript attempt is evaluated holistically or retried with deterministic fallback.
- Original recording remains strictly immutable (`upsert: false`).

## 2. Invariant Rules
1. Atomic persistence: `complete_transcription_job` RPC remains the only commit point for completed transcripts.
2. Provider routing:
   - Primary: `azure-mai`
   - Secondary / Indic fallback: `sarvam` (when configured / when Azure encounters non-retryable or repeated failure)
   - Safety fallback: `openrouter` (Whisper Large-v3-Turbo)
3. Provenance: Every provider stores its model, raw speaker labels, word timestamps (where supported), and preprocessing details.
