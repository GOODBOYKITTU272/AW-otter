# P3 Language-Based STT Provider Routing

## Overview

As of 2026-09-12, the transcription system implements **language-based routing** for Speech-to-Text (STT) provider selection. This replaces the previous Azure-first fallback chain with intelligent provider selection based on detected audio language.

## Locked Product Rule (Owner: 2026-09-12)

- **English only → Whisper** (OpenRouter Whisper Large-v3-Turbo)
- **Everything else (Hindi/Indic + all remaining languages) → Sarvam** (Sarvam Saaras:v4)
- **Stop** treating Azure MAI as the unconditional first provider

## How It Works

### 1. Language Detection Phase

Before full transcription, the system:
1. Extracts a 30-second audio sample from the beginning of the recording
2. Runs a fast Whisper transcription pass on the sample for language detection
3. Uses the detected language code to determine the optimal provider

### 2. Provider Routing Logic

```
Detected Language → Provider Selection
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
English (en*)     → Whisper (primary), Sarvam (fallback)
Hindi/Indic       → Sarvam (primary), Whisper (fallback)
All other langs   → Sarvam (primary), Whisper (fallback)
Unknown/null      → Sarvam (primary), Whisper (fallback)
```

### 3. Fallback Behavior

- If the primary provider fails (non-retryable error), the system automatically tries the fallback provider
- If both providers fail, the transcription job enters the retry queue
- Existing retry backoff and terminal failure logic remains unchanged

## Configuration

### Environment Variables

#### `ENABLE_LANGUAGE_ROUTING` (default: `true`)
Controls whether language-based routing is enabled. Set to `false` to revert to legacy behavior.

```bash
# Enable language-based routing (default)
ENABLE_LANGUAGE_ROUTING=true

# Disable language-based routing (legacy behavior)
ENABLE_LANGUAGE_ROUTING=false
```

#### `TRANSCRIPTION_PRIMARY_PROVIDER`
When set to `azure-mai`, language routing is **automatically disabled** for backward compatibility, and the system uses the legacy Azure → Sarvam → Whisper fallback chain.

```bash
# New behavior: Language-based routing
TRANSCRIPTION_PRIMARY_PROVIDER=openrouter  # or sarvam

# Legacy behavior: Azure-first chain
TRANSCRIPTION_PRIMARY_PROVIDER=azure-mai
```

#### `FFMPEG_PATH` / `FFPROBE_PATH` (new)
Override ffmpeg/ffprobe binary paths. Useful for Mac Homebrew installations.

```bash
# Docker/Linux (default)
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe

# Mac Homebrew
FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
FFPROBE_PATH=/opt/homebrew/bin/ffprobe
```

## Migration from Legacy Behavior

### Before (Legacy Azure-First Chain)
```
All meetings → Azure MAI → Sarvam → Whisper
```

Problems:
- Azure MAI applied to all languages, even when not optimal
- Fixed fallback order regardless of meeting language
- No language-aware routing

### After (Language-Based Routing)
```
Language Detection → English: Whisper → Sarvam
                  → Non-English: Sarvam → Whisper
```

Benefits:
- English meetings use best-in-class Whisper directly
- Indic languages get Sarvam's specialized models first
- Faster transcription (no unnecessary Azure attempts for English)
- More accurate results (language-appropriate provider selection)

## Observability

### Lifecycle Events

The system logs the following new lifecycle events:

#### `transcript.language_detected`
```json
{
  "eventType": "transcript.language_detected",
  "payload": {
    "detectedLanguage": "en",
    "routingDecision": "English detected → Whisper",
    "primaryProvider": "openrouter",
    "fallbackProvider": "sarvam"
  }
}
```

#### `transcript.language_detection_failed`
```json
{
  "eventType": "transcript.language_detection_failed",
  "payload": {
    "error": { "name": "TranscriptionTimeoutError", "message": "..." },
    "fallbackProvider": "openrouter"
  }
}
```

### Provider Metadata

The `meeting_transcripts.provider_metadata` JSONB column now includes:

```json
{
  "provider": "sarvam",
  "languageRoutingEnabled": true,
  "routingReason": "hi detected → Sarvam",
  "attempts": [
    { "sequence": 1, "provider": "sarvam", "outcome": "accepted" }
  ]
}
```

## Mixed-Language Meetings

For meetings with code-switching or multiple languages:
- The routing decision is based on the **first 30 seconds** of audio
- If the sample is primarily English, the meeting routes to Whisper
- If the sample is primarily non-English, the meeting routes to Sarvam
- Both providers (Whisper and Sarvam) support code-switching within their transcription output

### Recommendation
For organizations with frequent code-switching, consider:
1. Monitor `detectedLanguage` in lifecycle events
2. Adjust sample duration if needed (currently 30s)
3. Review provider metadata to understand routing decisions

## Testing

### Unit Tests
```bash
# Run language routing tests
pnpm test packages/domain/src/language-routing.test.ts
```

### Integration Tests
To verify language routing in a staging environment:

1. **English meeting**: Upload English-only audio, verify `primaryProvider: openrouter`
2. **Hindi meeting**: Upload Hindi audio, verify `primaryProvider: sarvam`
3. **Mixed meeting**: Upload code-switched audio, verify routing based on sample

## Troubleshooting

### Issue: Language detection always fails
**Symptoms**: All meetings log `transcript.language_detection_failed`

**Solutions**:
1. Check Whisper provider credentials (`OPENROUTER_API_KEY`)
2. Verify ffmpeg is available for sample extraction
3. Check worker logs for underlying error

### Issue: Wrong provider selected for language
**Symptoms**: English meeting uses Sarvam, or Hindi meeting uses Whisper

**Solutions**:
1. Check lifecycle event `payload.detectedLanguage` to see what was detected
2. Verify the first 30 seconds of audio are representative of the meeting
3. Consider adjusting sample extraction logic if needed

### Issue: Want to force a specific provider
**Solutions**:
```bash
# Disable language routing and use explicit provider
ENABLE_LANGUAGE_ROUTING=false
TRANSCRIPTION_PRIMARY_PROVIDER=sarvam  # or openrouter, or azure-mai
```

## Performance Impact

- **Language detection adds ~5-10s** to total transcription time (one-time cost per meeting)
- **Sample extraction is fast**: 30s sample created in ~1-2s
- **Detection pass is fast**: Whisper on 30s audio completes in ~3-8s
- **Net benefit**: Choosing the optimal provider first reduces retry/fallback costs

## Related Documentation

- [P3C Fallback Provider Reliability](./p3c-fallback-provider-reliability-trd.md) - Legacy Azure-first chain
- [P3B Azure Integration](./p3b-azure-integration-trd.md) - Azure MAI setup
- [Sarvam Benchmark Results](../../packages/transcription/benchmark/sarvam_bakeoff_summary.md) - Provider quality comparison

## Changelog

### 2026-09-12: Language-Based Routing (P3 Production Readiness)
- **Added**: Language detection using Whisper sample pass
- **Added**: `routeByLanguage` function for intelligent provider selection
- **Added**: English → Whisper, non-English → Sarvam routing logic
- **Added**: `ENABLE_LANGUAGE_ROUTING`, `FFMPEG_PATH`, `FFPROBE_PATH` env vars
- **Changed**: Azure MAI no longer unconditional first provider
- **Changed**: Provider selection now language-aware by default
- **Fixed**: FFMPEG_PATH hardcoding (now supports Mac Homebrew)
