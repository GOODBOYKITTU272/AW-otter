#!/usr/bin/env bash
# Durable, idempotent setup for the ApplyWizz Signal Cloud Agent environment.
# Runs once after checkout to build the environment baseline (and again to
# refresh dependencies). No long-running process is started here — per-boot
# services live in start.sh / terminals.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=./lib.sh
source "$REPO_ROOT/.cursor/lib.sh"

# Pin the Supabase CLI. CI uses "latest"; pinning keeps builds reproducible.
SUPABASE_CLI_VERSION="2.117.0"

echo "==> Installing system dependencies (docker, fuse-overlayfs, ffmpeg)"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
# ffmpeg: packages/domain/src/audio-transcode.ts shells out to the real
#   ffmpeg/ffprobe binaries (see CI). docker.io + fuse-overlayfs + uidmap:
#   run the local Supabase stack in the nested VM.
# The Dpkg::Options force-conf* flags auto-resolve the /etc/fuse.conf conffile
# prompt fuse3 raises (keeping the existing file); without them apt aborts
# with a non-interactive "EOF on stdin at conffile prompt" error.
sudo apt-get install -y -qq --no-install-recommends \
  -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" \
  docker.io fuse-overlayfs uidmap ffmpeg curl ca-certificates
# Safety net in case a package was left half-configured.
sudo dpkg --configure -a || true

echo "==> Installing Supabase CLI ${SUPABASE_CLI_VERSION}"
if [ "$(supabase --version 2>/dev/null || true)" != "${SUPABASE_CLI_VERSION}" ]; then
  tmpdeb="$(mktemp --suffix=.deb)"
  curl -fsSL -o "$tmpdeb" \
    "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_amd64.deb"
  sudo dpkg -i "$tmpdeb"
  rm -f "$tmpdeb"
fi

echo "==> Installing pnpm workspace dependencies"
corepack enable
pnpm install --frozen-lockfile

# Warm the Supabase Docker images into the image cache so they are captured in
# the environment snapshot and boots stay fast. Best-effort: never fail the
# install if warming has trouble — start.sh pulls anything missing on boot.
echo "==> Pre-pulling Supabase Docker images (best-effort)"
if ensure_docker; then
  fix_docker_forwarding
  supabase start --exclude "$SUPABASE_EXCLUDE" >/tmp/supabase-warm.log 2>&1 || \
    echo "   (warm start skipped/failed — images will be pulled on boot)"
  supabase stop --no-backup >/dev/null 2>&1 || true
else
  echo "   (docker unavailable during install — images will be pulled on boot)"
fi

echo "==> Install complete"
