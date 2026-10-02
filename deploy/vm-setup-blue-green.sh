#!/usr/bin/env bash
# Laptop-side wrapper: copy the one-time blue/green setup to the .6 VM and run it
# there (deploy/setup-blue-green.sh is idempotent — safe to re-run any time).
#
#   deploy/vm-setup-blue-green.sh          run the setup on the VM
#   deploy/vm-setup-blue-green.sh --show   print what would be copied/run
#
# Kept as ONE bare command so the Claude Code allow rule in
# scripts/allow-deploys.sh matches it (compound `scp … && ssh …` lines do not).
set -euo pipefail
cd "$(dirname "$0")/.."
VM="azureuser@172.17.0.6"
FILES=(deploy/setup-blue-green.sh deploy/nginx-meetings.conf deploy/maintenance.html)
if [[ "${1:-}" == "--show" ]]; then
  printf 'scp %s %s:/tmp/mw-setup/\nssh %s bash /tmp/mw-setup/setup-blue-green.sh\n' "${FILES[*]}" "$VM" "$VM"
  exit 0
fi
echo "==> copying ${FILES[*]} -> $VM:/tmp/mw-setup/"
ssh -n "$VM" 'mkdir -p /tmp/mw-setup'
scp -q "${FILES[@]}" "$VM:/tmp/mw-setup/"
echo "==> running setup-blue-green.sh on the VM"
ssh -n "$VM" 'bash /tmp/mw-setup/setup-blue-green.sh'
