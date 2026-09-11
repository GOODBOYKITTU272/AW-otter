# P3B Technical Requirements Document (TRD): Azure Production Transcription Integration

## 1. Objective & Scope
Connect **Azure MAI-Transcribe-2** to Apply Wizz Signal's existing production transcription abstraction (`TranscriptionProvider`) without altering upstream recording ingestion, Vexa bot flows, or downstream immutable transcript storage and AM review contracts.

## 2. Existing Production Architecture Inspection
- **Contract**: `TranscriptionProvider` (`packages/transcription/src/types.ts`) defines:
  ```typescript
  interface TranscriptionProvider {
    readonly name: string;
    transcribe(filePath: string, options?: TranscribeOptions): Promise<TranscriptionResult>;
  }
  ```
- **Current Provider**: `OpenRouterTranscriptionProvider` calling Whisper-Large-v3-Turbo.
- **Preprocessing Pipeline**: `transcodeToOpusOgg` in `packages/domain/src/audio-transcode.ts` converts raw Vexa recordings to 16kHz mono Opus/Ogg.
- **Persistence & Idempotency**: `complete_transcription_job` RPC (migration `20260908060003`) handles segment insertion, transcript state completion, and enforces that once a transcript is completed, its segments and record cannot be mutated or duplicated.
- **Provenance**: Stored in `meeting_transcripts.provider`, `meeting_transcripts.model`, `meeting_transcripts.provider_metadata`, and `meeting_transcripts.source_audio_reference`.

## 3. Azure MAI Production Provider Design (`AzureMaiTranscriptionProvider`)
- **Package**: `@applywizz/transcription`
- **Class**: `AzureMaiTranscriptionProvider implements TranscriptionProvider`
- **Configuration**:
  - Endpoint: `AZURE_MAI_ENDPOINT`
  - Key: `AZURE_MAI_KEY`
  - Region: `AZURE_MAI_REGION`
  - Model: `MAI-Transcribe-2`
  - API Version: `2025-10-15`
  - Enhanced Mode: `enabled: true`, `timestamps: "word"`, `transcribeStyle: "verbatim"`
  - Diarization: `enabled: true`
- **Normalization Boundary**:
  - Maps Azure phrase offsets and durations into `TranscriptionSegment` (`startMs`, `endMs`, `text`, `speakerTag`).
  - Preserves exact raw speaker tags (`Speaker 0`, `Speaker 1`, `speaker_unknown`) without business role mapping.
  - Retains word-level millisecond timestamps (`startMs`, `endMs`, `word`).
  - Records detected locale (e.g. `te`, `hi`, `en`).
- **Error Handling**:
  - Uses typed errors: `TranscriptionTimeoutError`, `TranscriptionApiError`, `TranscriptionMalformedResponseError`, `TranscriptionAuthError`.
  - Never logs or exposes raw request/response audio bodies.

## 4. Derived Audio Preprocessing
- Azure MAI requires standard PCM WAV audio (`16kHz mono PCM 16-bit`).
- Original recording remains immutable in Supabase Storage (`MEETING_RECORDINGS_BUCKET`).
- Domain introduces `transcodeToPcmWav(inputPath, outputPath)` in `packages/domain/src/audio-transcode.ts`.
- Provenance hashes:
  - Original recording SHA-256
  - Derived audio SHA-256
  - Codec, sample rate (16000), channel count (1), duration
  - Preprocessing version (`"v1-pcm16k"`)

## 5. Persistence & Provenance Mapping
- `meeting_transcripts.provider` = `"azure-mai"`
- `meeting_transcripts.model` = `"MAI-Transcribe-2"`
- `meeting_transcripts.provider_metadata` includes:
  - Preprocessing version and derived audio hash
  - Diarization requested (`true`)
  - Word timestamps requested (`true`)
  - Detected locale
- `transcript_segments.speaker_label` = `"Speaker 0"`, `"Speaker 1"` (or `"speaker_unknown"`)
- `transcript_segments.provider_segment_metadata` = `{ speakerTag, speakerNumericId, words }`
- `transcript_segments.speaker_source` = `"unavailable"` (preserves existing DB enum without migrations).

## 6. Testing Strategy
- Unit tests for `AzureMaiTranscriptionProvider` normalization and error handling.
- Unit tests for `transcodeToPcmWav` and SHA-256 calculation.
- Unit tests for `processTranscriptionJob` verifying speaker tag preservation and provenance.
- Verification that `OpenRouterTranscriptionProvider` tests remain 100% green.
- Live non-customer fixture smoke test against Azure MAI endpoint.
