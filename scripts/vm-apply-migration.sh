#!/usr/bin/env bash
# Apply one migrations/NNN_*.sql to the PRODUCTION database on the .6 VM.
#
#   scripts/vm-apply-migration.sh 051               # apply migrations/051_*.sql
#   scripts/vm-apply-migration.sh 051 --dry-run     # show what would run, touch nothing
#   scripts/vm-apply-migration.sh 051 --status      # only print the schema counts + the
#                                                   # file's objects, no DDL
#
# How it runs: the LOCAL file is streamed over ssh into `psql -f -` on the VM,
# with PG* taken from blue's ~/apps/meeting-whisperer/.env.local (green's
# .env.local is a symlink to it). The deployed tree is not involved, so a
# migration can be applied before, after, or without a deploy. `--single-
# transaction` + ON_ERROR_STOP: a failing statement rolls the whole file back.
#
# Guards: the file must exist and be committed with no local edits (it is what
# the next deploy ships, and what scratch-db.sh builds from); `--force-dirty`
# overrides that for a deliberate test. Every migration here hard-codes
# `SET search_path = meeting_whisperer_prod, public;` (spec §5a) — this script
# refuses a file that does not, so a scratch-schema sed copy can't be sent here
# by accident.
#
# The app role owns the schema, so no admin credentials are needed. Migrations
# are written IF NOT EXISTS where possible; re-running one is harmless but the
# counts printed before/after tell you whether anything actually changed.
set -euo pipefail
cd "$(dirname "$0")/.."

VM="azureuser@172.17.0.6"
ENV_FILE="/home/azureuser/apps/meeting-whisperer/.env.local"
SCHEMA="meeting_whisperer_prod"

say() { printf '==> %s\n' "$*"; }
die() { printf 'MIGRATION NOT APPLIED: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---- args -------------------------------------------------------------------
WHICH=""; DRY_RUN=0; STATUS_ONLY=0; FORCE_DIRTY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --status) STATUS_ONLY=1 ;;
    --force-dirty) FORCE_DIRTY=1 ;;
    -h|--help) usage 0 ;;
    -*) die "unknown flag $a" ;;
    *) [[ -z "$WHICH" ]] || die "one migration per run (got '$WHICH' and '$a')"; WHICH="$a" ;;
  esac
done
[[ -n "$WHICH" ]] || usage 1

# ---- resolve the file --------------------------------------------------------
if [[ -f "$WHICH" ]]; then
  FILE="$WHICH"
else
  matches=(migrations/"$WHICH"_*.sql)
  [[ ${#matches[@]} -eq 1 && -f "${matches[0]}" ]] || die "no single migrations/${WHICH}_*.sql (found: ${matches[*]:-none})"
  FILE="${matches[0]}"
fi
case "$FILE" in migrations/*.sql) ;; *) die "$FILE is not under migrations/" ;; esac

grep -qE "^SET search_path = ${SCHEMA}, public;" "$FILE" \
  || die "$FILE does not set search_path to $SCHEMA (spec §5a) — refusing to send it to prod"

if git ls-files --error-unmatch "$FILE" >/dev/null 2>&1 && git diff --quiet HEAD -- "$FILE"; then
  committed="committed ($(git log -1 --format=%h -- "$FILE"))"
else
  [[ $FORCE_DIRTY == 1 ]] || die "$FILE is untracked or has uncommitted edits — commit it first (or --force-dirty)"
  committed="UNCOMMITTED (--force-dirty)"
fi
sha="$(shasum -a 256 "$FILE" | cut -c1-12)"
say "$FILE — $(wc -l < "$FILE" | tr -d ' ') lines, sha256 $sha…, $committed"

# ---- what the file creates / alters (for the eye) ----------------------------
say "objects named in the file:"
grep -nEi '^\s*(CREATE|ALTER|DROP)\s' "$FILE" | sed 's/^/      /' || true

# ---- remote helpers ----------------------------------------------------------
# One ssh session per call; PG* come from the VM's .env.local, never from this laptop.
remote_psql() {  # $1 = extra psql args (string), stdin = sql
  ssh -n "$VM" "set -a; . '$ENV_FILE'; set +a; psql -X -q -v ON_ERROR_STOP=1 $1" 2>&1
}
remote_psql_stdin() {  # like remote_psql but passes OUR stdin through
  ssh "$VM" "set -a; . '$ENV_FILE'; set +a; psql -X -v ON_ERROR_STOP=1 $1" 2>&1
}

COUNTS_SQL="SELECT
  (SELECT count(*) FROM pg_tables   WHERE schemaname='$SCHEMA')                                      AS tables,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='$SCHEMA')                   AS columns,
  (SELECT count(*) FROM pg_indexes  WHERE schemaname='$SCHEMA')                                      AS indexes,
  current_user, current_database(), inet_server_addr()::text AS host, now() AT TIME ZONE 'Asia/Singapore' AS sgt;"

say "prod schema $SCHEMA before:"
remote_psql "-c \"$COUNTS_SQL\"" | sed 's/^/      /' || die "could not reach the database through $VM (is $ENV_FILE readable there?)"

if [[ $STATUS_ONLY == 1 ]]; then exit 0; fi
if [[ $DRY_RUN == 1 ]]; then
  say "dry run — would stream $FILE into: ssh $VM 'set -a; . $ENV_FILE; set +a; psql -X -v ON_ERROR_STOP=1 --single-transaction -f -'"
  exit 0
fi

# ---- apply -------------------------------------------------------------------
say "applying $FILE on $VM (single transaction; any error rolls everything back)"
remote_psql_stdin "--single-transaction -f -" < "$FILE" | sed 's/^/      /' \
  || die "psql reported an error — nothing from $FILE is committed (see output above)"

say "prod schema $SCHEMA after:"
remote_psql "-c \"$COUNTS_SQL\"" | sed 's/^/      /'
say "applied $FILE ($sha…) at $(TZ=Asia/Singapore date '+%Y-%m-%d %H:%M SGT')"
