#!/usr/bin/env bash
# Publish darth-cli with ONE family's subcommand rebuilt from its repo — and nothing else new.
#
#   scripts/publish-cli.sh [-m "<what changed>"]                       meetings from ./cli-subcommand-src (default)
#   scripts/publish-cli.sh --family artifacts --src ../holocrons/cli-subcommand-src -m "…"
#                                                                      any family from any committed source dir
#   scripts/publish-cli.sh --dry-run [...]                             build only, show what would ship; publish nothing
#
# Why a wrapper and not `bash ../cli/scripts/deploy.sh`: that script bundles EVERY family from its sibling
# working tree (../chat, ../tasks, ../holocrons, ../connectors, ../admin) and also rsyncs + restarts darth-auth from
# ../auth. A one-family release must not drag another session's unreleased work out with it. So every OTHER
# family is built from the copy the LAST release was built from (../cli/src/subcommands/<name>, which build.sh
# leaves behind — verify their mtimes match the served builtAt if in doubt), snapshotted to a temp dir first, and
# only the chosen family comes from --src (committed — the script refuses a dirty source dir). ../auth must
# already match what .6 runs (checksum dry-run) or the script stops: deploying auth changes is not this script's job.
#
# Families and the build.sh env var each one reads:
#   plagueis PLAGUEIS_SRC · artifacts ARTIFACTS_SRC · meetings MEETINGS_SRC · chat CHAT_SRC · gmail CONNECTORS_SRC ·
#   kb KB_SRC · admin ADMIN_SRC   (2026-10-15: --family/--src added; admin joined the snapshot list — before that the
#   wrapper rebuilt admin from ../admin's working tree on every meetings release)
#
# Before running: bump VERSION (and MIN_SUPPORTED_VERSION if a force-roll is wanted) in
# ../cli/src/core/version.ts with the usual comment block. The script refuses to republish a served version.
# Allow-listed for agents in .claude/settings.local.json (`Bash(scripts/publish-cli.sh:*)` — call it BARE from
# the repo root, no `cd … &&`, no pipes).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
CLI="$ROOT/../cli"
AUTH="$ROOT/../auth"
HOST=azureuser@172.17.0.6
PUBLIC=https://auth.darth-internal.trames.io/cli/version.json
DRY=0; MSG=""; FAMILY=meetings; SRC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift;;
    -m) MSG="$2"; shift 2;;
    --family) FAMILY="$2"; shift 2;;
    --src) SRC="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
[[ -d "$CLI/scripts" ]] || { echo "ERROR: $CLI not found"; exit 1; }
FAMILIES=(plagueis artifacts meetings chat gmail kb admin)
case " ${FAMILIES[*]} " in *" $FAMILY "*) ;; *) echo "ERROR: unknown family '$FAMILY' (one of: ${FAMILIES[*]})"; exit 2;; esac
[[ -n "$SRC" ]] || SRC="$ROOT/cli-subcommand-src"
SRC=$(cd "$SRC" && pwd)
[[ -n "$MSG" ]] || MSG="darth-cli $FAMILY"
envvar() { case "$1" in plagueis) echo PLAGUEIS_SRC;; artifacts) echo ARTIFACTS_SRC;; meetings) echo MEETINGS_SRC;; chat) echo CHAT_SRC;; gmail) echo CONNECTORS_SRC;; kb) echo KB_SRC;; admin) echo ADMIN_SRC;; esac; }

say() { printf '==> %s\n' "$*"; }

# 1. the chosen family's source is committed in ITS repo.
if [[ -n "$(git -C "$SRC" status --porcelain -- .)" ]]; then
  echo "ERROR: $SRC has uncommitted changes — commit them first:"; git -C "$SRC" status -s -- .; exit 1
fi

# 2. version bumped and not already served.
VERSION=$(grep '^export const VERSION' "$CLI/src/core/version.ts" | grep -o '[0-9]*\.[0-9]*\.[0-9]*')
SERVED=$(curl -fsS "$PUBLIC" | grep -o '"version": *"[0-9.]*"' | grep -o '[0-9]*\.[0-9]*\.[0-9]*' || true)
say "version.ts says $VERSION, served is ${SERVED:-unknown}"
[[ "$VERSION" != "$SERVED" ]] || { echo "ERROR: $VERSION is already served — bump ../cli/src/core/version.ts"; exit 1; }

# 3. ../auth must be what .6 already runs (deploy.sh rsyncs it; this release must not change it).
AUTH_DIFF=$(cd "$AUTH" && rsync -anci server.ts admin-app-token.ts darth-auth.service nginx-auth.conf src db scripts \
  "$HOST":~/darth-auth/ | grep -v -E '^\.[fdL] {9}' || true)
if [[ -n "$AUTH_DIFF" ]]; then
  echo "ERROR: ../auth differs from what .6 runs — deploy.sh would ship it. Not this script's call:"; echo "$AUTH_DIFF" | head -20; exit 1
fi
say "../auth matches .6 (darth-auth only gets restarted)"

# 4. snapshot every other family from the last release's build inputs; the chosen one comes from --src.
SNAP=$(mktemp -d "${TMPDIR:-/tmp}/publish-cli.XXXXXX")
trap 'rm -rf "$SNAP"' EXIT
for name in "${FAMILIES[@]}"; do
  if [[ "$name" == "$FAMILY" ]]; then export "$(envvar "$name")=$SRC"; continue; fi
  [[ -d "$CLI/src/subcommands/$name" ]] || { echo "ERROR: $CLI/src/subcommands/$name missing"; exit 1; }
  cp -R "$CLI/src/subcommands/$name" "$SNAP/$name"
  export "$(envvar "$name")=$SNAP/$name"
done
say "families: $FAMILY from $SRC; every other family as last released"

if [[ $DRY == 1 ]]; then
  (cd "$CLI" && bash scripts/build.sh)
  say "dry run: built $CLI/dist/darth-cli.js v$VERSION — nothing published"
  exit 0
fi

# 5. publish (deploy.sh re-exports chat/kb from these flags; the other *_SRC vars are inherited from the env).
(cd "$CLI" && bash scripts/deploy.sh --chat-src "$CHAT_SRC" --kb-src "$KB_SRC")

# 6. verify what is SERVED, not what was built.
NOW=$(curl -fsS "$PUBLIC")
echo "$NOW"
echo "$NOW" | grep -q "\"$VERSION\"" || { echo "ERROR: served version.json does not say $VERSION"; exit 1; }
LOCAL_SHA=$(shasum -a 256 "$CLI/dist/darth-cli.js" | cut -d' ' -f1)
REMOTE_SHA=$(ssh -n "$HOST" "sha256sum ~/darth-auth/cli-dist/darth-cli.js" | cut -d' ' -f1)
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] || { echo "ERROR: served bundle sha $REMOTE_SHA != built $LOCAL_SHA"; exit 1; }
say "served v$VERSION, bundle sha256 $LOCAL_SHA"

# 7. the release commit in ../cli is version.ts only (the subcommand copies are build artifacts).
if [[ -n "$(git -C "$CLI" status --porcelain -- src/core/version.ts)" ]]; then
  git -C "$CLI" add src/core/version.ts
  git -C "$CLI" commit -q -m "$VERSION: $MSG" -m "Published by meetings/scripts/publish-cli.sh --family $FAMILY (other families as last released)." -- src/core/version.ts
  say "committed ../cli $(git -C "$CLI" log --oneline -1)"
fi
