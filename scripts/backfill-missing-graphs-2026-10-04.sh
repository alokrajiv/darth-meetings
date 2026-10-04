#!/usr/bin/env bash
# One-off (2026-10-04): two meetings uploaded on 2026-10-02 never got a
# recording graph (no `recordings` / `recording_media` rows), so Stage A never
# archived their videos and Stage D left them on the VM's disk:
#   1056  d863cd97-ef03-41ef-9625-5c304849b88a  "SI-BL  Trames Weekly Update"
#   1054  2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5  "Triton Global Maritime Events - System Intro and Navigation"
# This runs the repo's recordings-backfill for exactly those two, on the VM,
# against prod. The sweeper then archives → read-back verifies → evicts them
# on its own within a few ticks. Re-running is harmless (the backfill skips a
# meeting that already has its graph).
#
#   scripts/backfill-missing-graphs-2026-10-04.sh            # dry run
#   scripts/backfill-missing-graphs-2026-10-04.sh --apply    # write the rows
set -euo pipefail
VM="azureuser@172.17.0.6"
DIR="/home/azureuser/apps/meeting-whisperer"   # blue; green's .env.local is a symlink to blue's
IDS="d863cd97-ef03-41ef-9625-5c304849b88a 2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5"
APPLY=""; [[ "${1:-}" == "--apply" ]] && APPLY="--apply --i-know-this-is-prod"

for id in $IDS; do
  echo "==> recordings-backfill ${APPLY:-(dry run)} --only $id"
  ssh "$VM" "export PATH=\"\$HOME/.bun/bin:\$PATH\"; cd '$DIR' && set -a && . ./.env.local && set +a \
    && SCHEMA_PREFIX=prod bun --conditions=react-server run scripts/recordings-backfill.ts $APPLY --only $id --check-files ./storage"
done
echo "==> media rows now:"
ssh "$VM" "cd '$DIR' && set -a && . ./.env.local && set +a && psql -X -q -c \"SET search_path = meeting_whisperer_prod, public;\" \
  -c \"SELECT filename, kind, pg_size_pretty(bytes) AS size, blob_name IS NOT NULL AS archived, local_evicted_at IS NOT NULL AS evicted FROM recording_media WHERE filename LIKE 'd863cd97-%' OR filename LIKE '2bd949dd-%';\""
