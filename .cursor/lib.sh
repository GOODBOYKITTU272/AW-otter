#!/usr/bin/env bash
# Shared helpers for the ApplyWizz Signal Cloud Agent environment scripts.
# Sourced by install.sh and start.sh.

# The local Supabase stack runs in Docker. Match CI's service subset
# (.github/workflows/ci.yml): the excluded services are heavy optional ones
# the app and DB/RLS tests do not need. Realtime in particular is excluded
# because it is unused by the app and only adds container-to-container load.
SUPABASE_EXCLUDE="edge-runtime,imgproxy,logflare,mailpit,postgres-meta,realtime,storage-api,studio,vector"

# Bring up the Docker daemon if it is not already responding. Uses the
# fuse-overlayfs storage driver, which is required in the nested Cloud Agent
# VM (the default overlay2 driver is not usable here). Idempotent: a healthy
# daemon is left untouched.
ensure_docker() {
  if ! sudo docker info >/dev/null 2>&1; then
    echo "==> Starting dockerd (fuse-overlayfs storage driver)"
    sudo bash -c 'nohup dockerd --storage-driver=fuse-overlayfs >/tmp/dockerd.log 2>&1 &'
    for _ in $(seq 1 45); do
      sudo docker info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if ! sudo docker info >/dev/null 2>&1; then
    echo "!! dockerd did not become ready; last log lines:" >&2
    sudo tail -n 40 /tmp/dockerd.log >&2 || true
    return 1
  fi
  # Let the (non-root) environment user drive Docker without sudo so the
  # Supabase CLI can reach the daemon.
  sudo chmod 666 /var/run/docker.sock || true
}

# Docker installs its NAT/forward rules through the nftables-backed iptables,
# but Ubuntu 24.04 also carries stray legacy iptables tables whose FORWARD
# policy defaults to DROP. The kernel evaluates both, so that legacy DROP
# silently kills container-to-container traffic (observed as Supabase's schema
# migrate step timing out while connecting to Postgres). Force the legacy
# FORWARD policy to ACCEPT so bridged traffic between containers flows.
fix_docker_forwarding() {
  if command -v iptables-legacy >/dev/null 2>&1; then
    sudo iptables-legacy -P FORWARD ACCEPT || true
  fi
}
