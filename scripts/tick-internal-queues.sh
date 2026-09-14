#!/usr/bin/env bash
# Workers-VM tick for Echo /api/internal/* routes that Vercel Hobby does not
# execute as crons (Hobby only reliably runs microsoft-subscriptions/renew).
#
# Deployed on applywizz-signal-workers-vm as:
#   /home/awworker/applywizz-signal/bin/tick-internal-queues.sh
# Cron (every minute):
#   * * * * * /home/awworker/applywizz-signal/bin/tick-internal-queues.sh
#
# Required env (worker-env/.env on the VM):
#   APP_BASE_URL            Production Echo base URL, e.g. https://echo.applywizz.ai
#   INTERNAL_QUEUE_SECRET   Same secret as other /api/internal/* routes; sent as
#                           header x-internal-queue-secret
#
# Optional:
#   INTERNAL_TICK_LOG       Default: /home/awworker/applywizz-signal/logs/internal-ticks.log
#   INTERNAL_TICK_LOCK      Default: /tmp/aw-internal-tick.lock (flock; skip if busy)
#
# Auth matches apps/web/lib/internal-route-auth.ts (x-internal-queue-secret).
# Do not log secrets. Response bodies are truncated to 300 chars.
set -euo pipefail

ENV_FILE="${INTERNAL_TICK_ENV_FILE:-/home/awworker/applywizz-signal/worker-env/.env}"
LOCK_FILE="${INTERNAL_TICK_LOCK:-/tmp/aw-internal-tick.lock}"
log="${INTERNAL_TICK_LOG:-/home/awworker/applywizz-signal/logs/internal-ticks.log}"

# Skip overlapping minute crons (recover/outcome/intelligence can exceed 60s).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "$ts SKIP locked (previous tick still running)" >> "$log"
  exit 0
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

BASE="${APP_BASE_URL:-https://echo.applywizz.ai}"
SECRET="${INTERNAL_QUEUE_SECRET:?missing INTERNAL_QUEUE_SECRET}"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

paths=(
  /api/internal/calendar-events/process
  /api/internal/meeting-policy/evaluate
  /api/internal/meeting-outcome/process
  /api/internal/meeting-intelligence/process
  /api/internal/operations/recover
)

for path in "${paths[@]}"; do
  body="/tmp/aw-tick-body-$(echo "$path" | tr / _).json"
  set +e
  code=$(curl -sS -m 120 -o "$body" -w "%{http_code}" -X POST "${BASE}${path}" \
    -H "x-internal-queue-secret: ${SECRET}" \
    -H "Content-Type: application/json")
  curl_ec=$?
  set -e
  if [ "$curl_ec" -ne 0 ] && [ -z "$code" ]; then
    code=000
  fi
  snippet=$(head -c 300 "$body" 2>/dev/null | tr '\n' ' ' || true)
  echo "$ts $path HTTP $code $snippet" >> "$log"
done
