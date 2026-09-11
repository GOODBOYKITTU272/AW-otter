# FFmpeg Installation and Configuration

## Overview

The transcription worker requires `ffmpeg` and `ffprobe` to transcode audio recordings before sending them to speech-to-text providers. This document describes how ffmpeg is installed and configured to prevent common runtime errors.

## Container Installation

The `workers/transcription-worker/Dockerfile` installs ffmpeg using the standard Debian/Ubuntu package manager:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && which ffmpeg && which ffprobe
```

This installs:
- `/usr/bin/ffmpeg` - The main transcoding binary
- `/usr/bin/ffprobe` - The audio file inspection binary

Both binaries are part of the `ffmpeg` package on Debian/Ubuntu systems.

## Code Usage

The application code in `packages/domain/src/audio-transcode.ts` uses **absolute paths** to prevent ENOENT (file not found) errors:

```typescript
const FFMPEG_PATH = "/usr/bin/ffmpeg";
const FFPROBE_PATH = "/usr/bin/ffprobe";
```

This approach is more reliable than using bare command names like `"ffmpeg"` because:
1. It doesn't depend on the `PATH` environment variable being configured correctly
2. It makes the dependency explicit and verifiable at runtime
3. It matches the known installation path from the Dockerfile

## Local Development

For local development outside Docker:

### macOS
```bash
brew install ffmpeg
```

This installs ffmpeg to `/opt/homebrew/bin/ffmpeg` (Apple Silicon) or `/usr/local/bin/ffmpeg` (Intel).

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install -y ffmpeg
```

This installs to `/usr/bin/ffmpeg`.

### Verification

Verify installation:
```bash
which ffmpeg
which ffprobe
ffmpeg -version
```

## Troubleshooting

### ENOENT Errors

If you see errors like:
```
Error: spawn ffmpeg ENOENT
```

This means ffmpeg is not found at the expected path. Check:
1. Is ffmpeg installed? `which ffmpeg`
2. Is it at `/usr/bin/ffmpeg`? If not, update `FFMPEG_PATH` constant
3. For local development, ensure ffmpeg is in your PATH

### Permission Issues

Ensure the binary is executable:
```bash
ls -la /usr/bin/ffmpeg
# Should show: -rwxr-xr-x (executable)
```

### Container Build Issues

If the Dockerfile build fails on ffmpeg installation:
```bash
docker build --no-cache -t test-worker -f workers/transcription-worker/Dockerfile .
docker run -it test-worker which ffmpeg
```

This verifies the installation succeeded.

## Related Documentation

- `workers/transcription-worker/Dockerfile` - Container image definition
- `packages/domain/src/audio-transcode.ts` - Transcoding implementation
- `docs/ops/production-environment.md` - Overall production setup
