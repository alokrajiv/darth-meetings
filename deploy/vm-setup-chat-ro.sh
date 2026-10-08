#!/usr/bin/env bash
# One-off, idempotent: let Darth Meetings FOLLOW Darth Chat's Claude login allocation.
#
#   deploy/vm-setup-chat-ro.sh            # run from the laptop; everything happens on .6 over ssh
#   deploy/vm-setup-chat-ro.sh --show     # print what it would do, change nothing
#
# What it does on the VM (azureuser, passwordless sudo to postgres):
#   1. creates PG role `darth_chat_ro` (LOGIN, fresh random password) if missing,
#      and grants it CONNECT on darth_chat + SELECT on exactly three tables:
#      claude_allocation, claude_allocation_overrides, envs — the rows
#      src/lib/server/claude-profile.ts reads to pick the same profile chat would.
#   2. appends to blue's ~/apps/meeting-whisperer/.env.local (green's is a symlink):
#        MW_CLAUDE_CREDS_DIR=/home/azureuser/.creds
#        MW_CLAUDE_FOLLOW_EMAIL=alok@trames.sg
#        MW_DARTH_CHAT_DATABASE_URL=postgres://darth_chat_ro:<pw>@127.0.0.1:5432/darth_chat
#      (a .bak-<date> copy is kept; a second run that finds the URL already there does nothing)
#   3. proves the role: reads the live allocation, and confirms it CANNOT read chats.
# The password is generated on the VM and never printed; it lives only in .env.local.
# After this: ./deploy.sh (the app reads the new env at start) — until then the
# runner uses the VM's own `claude` login as before.
set -euo pipefail
cd "$(dirname "$0")/.."

VM="azureuser@172.17.0.6"
SHOW=0
[[ "${1:-}" == "--show" ]] && SHOW=1

if (( SHOW )); then
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

ssh "$VM" bash -s <<'REMOTE'
set -euo pipefail
ENV=/home/azureuser/apps/meeting-whisperer/.env.local
ROLE=darth_chat_ro
say() { printf '==> %s\n' "$*"; }

if grep -q '^MW_DARTH_CHAT_DATABASE_URL=' "$ENV"; then
  say "$ENV already has MW_DARTH_CHAT_DATABASE_URL — nothing to do"
  URL=$(grep '^MW_DARTH_CHAT_DATABASE_URL=' "$ENV" | cut -d= -f2-)
else
  PW=$(openssl rand -hex 24)
  say "role $ROLE (create if missing, set password)"
  sudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d darth_chat -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') THEN
    CREATE ROLE $ROLE LOGIN;
  END IF;
END \$\$;
ALTER ROLE $ROLE PASSWORD '$PW';
GRANT CONNECT ON DATABASE darth_chat TO $ROLE;
GRANT USAGE ON SCHEMA public TO $ROLE;
GRANT SELECT ON claude_allocation, claude_allocation_overrides, envs TO $ROLE;
SQL
  URL="postgres://$ROLE:$PW@127.0.0.1:5432/darth_chat"
  cp -p "$ENV" "$ENV.bak-$(date +%Y%m%d-%H%M%S)"
  {
    printf '\n# Claude login shared with Darth Chat (2026-10-08): follow chat'"'"'s live allocation for this person,\n'
    printf '# use ~/.creds/<profile>.token (src/lib/server/claude-profile.ts; role made by deploy/vm-setup-chat-ro.sh)\n'
    printf 'MW_CLAUDE_CREDS_DIR=/home/azureuser/.creds\n'
    printf 'MW_CLAUDE_FOLLOW_EMAIL=alok@trames.sg\n'
    printf 'MW_DARTH_CHAT_DATABASE_URL=%s\n' "$URL"
  } >> "$ENV"
  say "env lines appended to $ENV"
fi

say "proof: the role reads the allocation"
psql "$URL" -XAt -F' | ' -c "SELECT default_profile, auto->>'order' AS rotation, (SELECT count(*) FROM claude_allocation_overrides WHERE until > now()) AS live_overrides FROM claude_allocation WHERE id = 'live'"
say "proof: the role cannot read chats (expect 'permission denied')"
psql "$URL" -XAt -c "SELECT 1 FROM chats LIMIT 1" 2>&1 | head -1 || true
say "token files chat can hand out:"
ls -l /home/azureuser/.creds/*.token | awk '{print "   " $1, $NF}'
REMOTE
