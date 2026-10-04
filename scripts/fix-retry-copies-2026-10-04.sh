#!/usr/bin/env bash
# One-off (2026-10-04): two meetings made from Darth Recorder uploads on
# 2026-10-02 were re-ingested by a MANUAL ingest retry the same day, before
# ingest-retry learned that a borrower is retried through its recording
# (`retryBorrower`). The retry copied the recording's canonical file under the
# MEETING's name and pointed `transcripts.local_audio_path` at that copy:
#   1056  d863cd97-ef03-41ef-9625-5c304849b88a.mp4  = recording 793c624b's canonical (172 MB)
#   1054  2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5.mp4  = recording 02af969f's canonical (268 MB)
# No media row owns those copies, so Stage A never archived them and Stage D
# never evicted them. The bytes are byte-identical (sha256) to the canonical
# blobs, which are read-back verified and already evicted locally.
#
# This script, per meeting: (1) re-hashes the local copy and REFUSES unless it
# equals the canonical's `blob_verified_sha256`; (2) with --apply, points
# `local_audio_path` at the canonical filename (what the other 15 recorder-born
# meetings already carry — readers then resolve through the media row and the
# blob, the path Stage D proved) and deletes the copy. Nothing else is written;
# the canonical's ledger rows (media_local_evictions 1023, 1026) already exist.
#
#   scripts/fix-retry-copies-2026-10-04.sh            # dry run: hash check only
#   scripts/fix-retry-copies-2026-10-04.sh --apply    # repoint + delete
set -euo pipefail
VM="azureuser@172.17.0.6"
DIR="/home/azureuser/apps/meeting-whisperer"   # blue; green's .env.local is a symlink to blue's
SCHEMA="meeting_whisperer_prod"
APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1

# transcript id | duplicate file | recording id | canonical filename
ROWS=(
  "1056|d863cd97-ef03-41ef-9625-5c304849b88a.mp4|793c624b-1cd0-4443-943e-4a9796dc2522|793c624b-1cd0-4443-943e-4a9796dc2522.mp4"
  "1054|2bd949dd-c829-4cdd-a2b6-d2a86b2eefd5.mp4|02af969f-ee5e-4c82-879f-5d971e568e6c|02af969f-ee5e-4c82-879f-5d971e568e6c.mp4"
)

psql_stdin() {  # SQL on stdin → prod psql on the VM, tuples only
  ssh "$VM" "set -a; . '$DIR/.env.local'; set +a; psql -X -tA -q -v ON_ERROR_STOP=1 -f -"
}

for r in "${ROWS[@]}"; do
  IFS='|' read -r tid dup rec canon <<<"$r"
  echo "==> meeting $tid: $dup → should be recording $rec's $canon"
  want=$(printf "SELECT blob_verified_sha256 FROM %s.recording_media WHERE recording_id = '%s' AND kind = 'canonical' AND ord = 0 AND filename = '%s' AND local_evicted_at IS NOT NULL AND blob_verified_sha256 = sha256;\n" "$SCHEMA" "$rec" "$canon" | psql_stdin)
  cur=$(printf "SELECT local_audio_path FROM %s.transcripts WHERE id = %s;\n" "$SCHEMA" "$tid" | psql_stdin)
  have=$(ssh "$VM" "test -f '$DIR/storage/audio/$dup' && sha256sum '$DIR/storage/audio/$dup' | cut -d' ' -f1 || echo missing")
  if [[ "$have" == "missing" && "$cur" == "$canon" ]]; then echo "    already done (file gone, row points at $canon)"; continue; fi
  if [[ -z "$want" ]]; then echo "    REFUSED: canonical not verified+evicted in the database"; exit 1; fi
  if [[ "$have" != "$want" ]]; then echo "    REFUSED: local sha $have ≠ verified blob sha $want"; exit 1; fi
  if [[ "$cur" != "$dup" ]]; then echo "    REFUSED: local_audio_path is '$cur', expected '$dup'"; exit 1; fi
  echo "    ok: local copy == verified blob ($have)"
  if (( APPLY )); then
    out=$(printf "UPDATE %s.transcripts SET local_audio_path = '%s' WHERE id = %s AND local_audio_path = '%s' RETURNING id;\n" "$SCHEMA" "$canon" "$tid" "$dup" | psql_stdin)
    [[ "$out" == "$tid" ]] || { echo "    REFUSED: update matched '$out', not 1 row — file kept"; exit 1; }
    echo "    repointed local_audio_path → $canon"
    ssh "$VM" "rm -v '$DIR/storage/audio/$dup'"
  else
    echo "    dry run: would repoint local_audio_path and delete the copy"
  fi
done

echo "==> transcripts now:"
printf "SELECT id, local_audio_path FROM %s.transcripts WHERE id IN (1054, 1056) ORDER BY id;\n" "$SCHEMA" | psql_stdin
echo "==> storage/audio over 20 MB:"
ssh "$VM" "find '$DIR/storage/audio' -type f -size +20M -printf '%s %TY-%Tm-%Td %f\n' | sort -n; du -sh '$DIR/storage'"
