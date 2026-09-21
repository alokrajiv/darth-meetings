#!/usr/bin/env bash
#
# A scratch Postgres for the integration checks — BUILT FROM THE REPO ALONE.
#
# Until 2026-09-22 every check under `tmp/*/setup.sh` rebuilt its schema from a
# `pg_dump --schema-only` of the PRODUCTION database, so running the suite
# needed a live tunnel to prod. `migrations/000_base_schema.sql` is the
# reconstructed pre-migration base, so the schema is now
#
#     000_base_schema.sql  +  001…047
#
# and nothing outside this repo is read. (Verified 2026-09-22: 000 + 001…043
# reproduces the prod schema byte for byte under a normalised pg_dump.)
#
# NEVER the VM, NEVER prod: own port, own datadir, `trust` auth on 127.0.0.1,
# and the only thing that ever touches a network is nothing at all.
#
# Usage
# -----
#   scripts/scratch-db.sh up   --dir DIR --port P --db NAME --schema-prefix PFX
#                              [--through NNN]   # last migration to apply
#   scripts/scratch-db.sh apply     --port P --db NAME --schema-prefix PFX
#                              [--through NNN]   # schema only, cluster already up
#   scripts/scratch-db.sh down --dir DIR
#
#   `--schema-prefix p3btest` builds schema `meeting_whisperer_p3btest`, which
#   is what `SCHEMA_PREFIX=p3btest` makes the app use
#   (src/lib/constants/database.ts).
#
# Example
#   bash scripts/scratch-db.sh up --dir tmp/foo --port 55927 \
#        --db mw_p3b --schema-prefix p3btest
#   bash scripts/scratch-db.sh down --dir tmp/foo
#
set -euo pipefail

export PATH=/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CMD="${1:-}"; shift || true
DIR=""; PORT=""; DB=""; PREFIX=""; THROUGH="999"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)           DIR="$2"; shift 2 ;;
    --port)          PORT="$2"; shift 2 ;;
    --db)            DB="$2"; shift 2 ;;
    --schema-prefix) PREFIX="$2"; shift 2 ;;
    --through)       THROUGH="$2"; shift 2 ;;
    *) echo "scratch-db.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

die() { echo "scratch-db.sh: $*" >&2; exit 2; }

case "$CMD" in
  down)
    [[ -n "$DIR" ]] || die "down needs --dir"
    [[ "$DIR" = /* ]] || DIR="$ROOT/$DIR"
    pg_ctl -D "$DIR/pgdata" stop >/dev/null 2>&1 || true
    rm -rf "$DIR/pgdata"
    echo "scratch cluster stopped and deleted ($DIR/pgdata)"
    exit 0 ;;
  up|apply) ;;
  *) sed -n '3,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

[[ -n "$PORT"   ]] || die "$CMD needs --port"
[[ -n "$DB"     ]] || die "$CMD needs --db"
[[ -n "$PREFIX" ]] || die "$CMD needs --schema-prefix"
SCHEMA="meeting_whisperer_$PREFIX"
[[ "$SCHEMA" != "meeting_whisperer_prod" ]] || die "refusing to build the PROD schema name"

if [[ "$CMD" == up ]]; then
  [[ -n "$DIR" ]] || die "up needs --dir"
  [[ "$DIR" = /* ]] || DIR="$ROOT/$DIR"
  mkdir -p "$DIR"
  pg_ctl -D "$DIR/pgdata" stop >/dev/null 2>&1 || true
  rm -rf "$DIR/pgdata"
  initdb -D "$DIR/pgdata" -U mw --auth=trust > "$DIR/initdb.log" 2>&1
  pg_ctl -D "$DIR/pgdata" \
    -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1" \
    -l "$DIR/pg.log" start > /dev/null
  createdb -h 127.0.0.1 -p "$PORT" -U mw "$DB"
fi

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U mw -d "$DB")

# Belt and braces: whatever the caller's shell exports, this is a local trust
# cluster and must stay one.
unset PGPASSWORD PGSSLMODE PGSERVICE DATABASE_URL PGHOST PGPORT PGUSER PGDATABASE 2>/dev/null || true

have=$("${PSQL[@]}" -tAc "SELECT current_database()")
[[ "$have" == "$DB" ]] || die "connected to '$have', expected '$DB' — refusing to write"

"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS $SCHEMA" > /dev/null

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

count=0
for f in "$ROOT"/migrations/[0-9][0-9][0-9]_*.sql; do
  n="$(basename "$f")"; n="${n:0:3}"
  # 10# or bash reads `044` as octal.
  (( 10#$n <= 10#$THROUGH )) || continue
  # Two things at once: migrations 020 / 024 / 025 carry no `SET search_path`
  # at all and inherit the caller's (so we prepend one), and every other
  # migration hard-codes the PROD schema on one line (so we sed it) — the same
  # rewrite the old per-check setup.sh scripts did by hand.
  {
    echo "SET search_path = $SCHEMA, public;"
    sed "s/^SET search_path = meeting_whisperer_prod, public;/SET search_path = $SCHEMA, public;/" "$f"
  } > "$TMP/m.sql"
  "${PSQL[@]}" -f "$TMP/m.sql" > /dev/null
  count=$((count + 1))
done

echo "schema $SCHEMA built in $DB on 127.0.0.1:$PORT — $count migration files (000 through $THROUGH)"
