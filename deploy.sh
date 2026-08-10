#!/usr/bin/env bash
# Deploy meeting-whisperer to the .6 VM.
#
#   ./deploy.sh            rsync + install + build + pm2 restart + health check
#   ./deploy.sh --dry-run  show what rsync would send, change nothing
#
# The VM keeps its own .env.local, storage/ and node_modules — never synced.
set -euo pipefail

VM="azureuser@172.17.0.6"
APP_DIR="/home/azureuser/apps/meeting-whisperer"
HEALTH_URL="https://meetings.darth-internal.trames.io/login"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

RSYNC_FLAGS=(-az --delete)
if [[ "${1:-}" == "--dry-run" ]]; then
  RSYNC_FLAGS+=(--dry-run -v)
fi

echo "==> rsync ${SRC_DIR}/ -> ${VM}:${APP_DIR}/"
rsync "${RSYNC_FLAGS[@]}" \
  --exclude node_modules \
  --exclude .next \
  --exclude .env.local \
  --exclude .git \
  --exclude storage \
  --exclude tmp \
  --exclude .playwright-mcp \
  --exclude '*.png' \
  "${SRC_DIR}/" "${VM}:${APP_DIR}/"

[[ "${1:-}" == "--dry-run" ]] && { echo "==> dry run only, stopping."; exit 0; }

echo "==> install + build on VM"
ssh "$VM" "export PATH=\"\$HOME/.bun/bin:\$PATH\" && cd '$APP_DIR' && bun install && bun run build" \
  | tail -5

echo "==> pm2 restart"
ssh "$VM" "pm2 restart meeting-whisperer --update-env && sleep 3 && pm2 ls | grep meeting-whisperer"

echo "==> health check"
code=$(curl -sk -o /dev/null -w '%{http_code}' "$HEALTH_URL")
if [[ "$code" != "200" ]]; then
  echo "HEALTH CHECK FAILED: $HEALTH_URL returned $code" >&2
  ssh "$VM" "pm2 logs meeting-whisperer --nostream --lines 30" || true
  exit 1
fi
echo "==> deployed OK ($HEALTH_URL -> $code)"
