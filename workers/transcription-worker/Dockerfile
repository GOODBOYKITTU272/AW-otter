# M17B transcription worker. Copies the full pnpm workspace (this .mjs
# script has no build step and resolves @applywizz/* via the monorepo's
# own node_modules symlinks — the exact same way
# workers/orchestrator/bot-worker.mjs already runs, just containerized
# because THIS worker specifically needs ffmpeg/ffprobe, which is the one
# thing a bare Node process can't be guaranteed to have — see
# docs/ops/production-environment.md §11).
FROM node:22-slim

# Same package CI already proves is sufficient for this exact codebase's
# transcode step (.github/workflows/ci.yml: "apt-get install ffmpeg") —
# ffmpeg pulls in ffprobe as part of the same package on Debian/Ubuntu.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /repo

# Full monorepo copy — this worker imports workspace packages
# (@applywizz/domain, @applywizz/transcription) that aren't independently
# publishable, so it needs the real pnpm workspace install, not a
# standalone bundle. Layer-cache the install separately from source.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ packages/
COPY workers/ workers/

RUN pnpm install --frozen-lockfile --prod=false

ENV HEARTBEAT_PATH=/tmp/transcription-worker-heartbeat

# Unhealthy if no tick has succeeded in 3x the default tick interval
# (60s default -> 180s here) — a genuinely stuck worker (not just one
# slow tick) gets flagged for the container orchestrator to restart.
# --start-period gives the process room to boot and complete a first
# real tick before failures start counting against it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD test -f "$HEARTBEAT_PATH" && test $(( $(date +%s) - $(stat -c %Y "$HEARTBEAT_PATH") )) -lt 180

# Must run via tsx, not plain node — see transcription-worker.mjs's own
# header comment for why (confirmed by actually running both, not assumed).
#
# Must invoke the pnpm-installed tsx binary directly, NOT via `npx` —
# confirmed by actually sending SIGTERM to a running container: npx spawns
# tsx through its own internal `sh -c` hop that does not forward signals,
# so the graceful-shutdown handler inside transcription-worker.mjs never
# ran at all (no log line for it, ever). node_modules/.bin/tsx is pnpm's
# own shim, which ends in `exec node .../tsx/dist/cli.mjs "$@"` — a real
# exec, not a fork, so the final Node process (running this script) lands
# on PID 1 and receives signals directly. Re-verified after this fix:
# SIGTERM now reaches the handler and logs the graceful-shutdown message.
CMD ["node_modules/.bin/tsx", "workers/transcription-worker/transcription-worker.mjs"]
