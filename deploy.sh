#!/usr/bin/env bash
# Deploy Darth Meetings to the .6 VM — blue/green, zero downtime.
#
#   ./deploy.sh                       deploy (see the steps below)
#   ./deploy.sh --dry-run             show the plan + what rsync would send; change nothing
#   ./deploy.sh --message "<text>" [--eta 10m] [--keep-notice]
#                                     post the owner's notice first, deploy, clear it at the end
#   ./deploy.sh --notice "<text>" [--eta 10m]   post / replace the notice only (no deploy)
#   ./deploy.sh --clear-notice                 remove the notice only (no deploy)
#
#   DEPLOY_FORCE=1      do not wait for the old colour's AI runs before stopping it
#   DRAIN_GRACE_S=15    seconds the old colour keeps serving in-flight requests after the flip
#
# Two copies of the app live on the VM (README "Deploy"; one-time setup:
# deploy/setup-blue-green.sh):
#   blue  /home/azureuser/apps/meeting-whisperer        pm2 meeting-whisperer        :3002
#   green /home/azureuser/apps/meeting-whisperer-green  pm2 meeting-whisperer-green  :3012
# /etc/nginx/mw-active.conf says which one is live. A deploy:
#   1. reads the live colour; the OTHER one is the target (its process is stopped);
#   2. rsyncs the source into the target dir and runs `bun install && bun run
#      build` THERE — the live tree and process are never touched;
#   3. drain files (src/lib/server/deploy-drain.ts): <live dir>/.mw-draining —
#      the live process stops STARTING background passes (pollers/sweepers;
#      it keeps serving requests) — and <target dir>/.mw-draining, so the
#      target boots passive;
#   4. starts the target, health-checks it on its own port (/api/health → 204,
#      /login → 302); on failure stops it, removes the live drain file, exits
#      1 — nothing users see has changed;
#   5. rewrites mw-active.conf (target live, old as backup), nginx -t, nginx -s
#      reload — graceful, no request is dropped; checks the public URL (flips
#      back by itself when that fails);
#   6. after DRAIN_GRACE_S, waits until the OLD colour has no Claude Agent SDK
#      run (only processes under <old dir>/node_modules count — never darth-chat's
#      or the new colour's), stops it, pm2 save;
#   7. removes the target's drain file: its background jobs start (each skipped
#      one runs once within 10 s); clears the notice.
#
# Background jobs never run in both colours at once (several are not safe to —
# README "Deploy"): from step 3 to step 7 they are paused everywhere, normally
# well under a minute; up to 15 min when the old colour has an AI run to finish
# (after 15 min the target is activated anyway and the old colour is left
# running, drained, for you to stop). HTTP traffic never pauses.
#
# The VM keeps its own .env.local, storage/ and node_modules — never synced
# (green's .env.local and storage are symlinks to blue's).
set -euo pipefail

VM="azureuser@172.17.0.6"
APPS="/home/azureuser/apps"
BLUE_DIR="$APPS/meeting-whisperer";        BLUE_APP="meeting-whisperer";        BLUE_PORT=3002
GREEN_DIR="$APPS/meeting-whisperer-green"; GREEN_APP="meeting-whisperer-green"; GREEN_PORT=3012
ACTIVE_CONF="/etc/nginx/mw-active.conf"
NOTICE_DIR="/var/www/mw-maintenance"
PUBLIC="https://meetings.darth-internal.trames.io"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DRAIN_GRACE_S="${DRAIN_GRACE_S:-15}"

say() { printf '==> %s\n' "$*"; }
NOTICE_POSTED=0
die() {
  printf 'DEPLOY FAILED: %s\n' "$*" >&2
  [[ $NOTICE_POSTED == 1 ]] && printf 'The notice is still up — ./deploy.sh --clear-notice (or --notice "<new text>").\n' >&2
  exit 1
}
usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ---- args -------------------------------------------------------------------
DRY_RUN=0; MESSAGE=""; NOTICE_ONLY=""; CLEAR_ONLY=0; ETA=""; KEEP_NOTICE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --message) [[ $# -ge 2 ]] || die "--message needs the text"; MESSAGE="$2"; shift ;;
    --notice) [[ $# -ge 2 ]] || die "--notice needs the text"; NOTICE_ONLY="$2"; shift ;;
    --clear-notice) CLEAR_ONLY=1 ;;
    --eta) [[ $# -ge 2 ]] || die "--eta needs a duration (10m, 1h, 90s)"; ETA="$2"; shift ;;
    --keep-notice) KEEP_NOTICE=1 ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage 1 ;;
  esac
  shift
done
[[ -n "$NOTICE_ONLY" && $CLEAR_ONLY == 1 ]] && die "--notice and --clear-notice together make no sense"
[[ -n "$MESSAGE" && ( -n "$NOTICE_ONLY" || $CLEAR_ONLY == 1 ) ]] && die "--message deploys; --notice/--clear-notice do not — pick one"
[[ -n "$ETA" && -z "$MESSAGE" && -z "$NOTICE_ONLY" ]] && die "--eta goes with --message or --notice"
for t in "$MESSAGE" "$NOTICE_ONLY"; do [[ -z "$t" || -n "${t//[[:space:]]/}" ]] || die "the notice text is blank"; done

# "10m" / "1h" / "90s" / "15" (minutes) → seconds
eta_seconds() {
  [[ "$1" =~ ^([0-9]+)([smh]?)$ ]] || die "--eta '$1': use e.g. 10m, 1h, 90s"
  local n="${BASH_REMATCH[1]}" u="${BASH_REMATCH[2]:-m}"
  case "$u" in s) echo "$n" ;; m) echo $((n * 60)) ;; h) echo $((n * 3600)) ;; esac
}

GIT_SHA="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
# One BUILD_ID per deploy: the VM checkout has no .git (excluded below), so
# next.config.ts could not derive it there; sha + timestamp keeps it unique
# per deploy even when the same commit is redeployed.
BUILD_ID="$GIT_SHA-$(date +%s)"

# ---- notice -------------------------------------------------------------------
# /var/www/mw-maintenance/notice.json, served by nginx at /__notice.json (read by
# the app's banner, its error page, nginx's maintenance page and the desktop
# shell). Always the owner's own words; written atomically (tmp + mv).
notice_json() { # <message> <eta seconds or empty>
  MSG="$1" ETA_S="$2" BUILD="$BUILD_ID" python3 -c '
import json, os, datetime as dt
now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
eta = os.environ["ETA_S"]
print(json.dumps({
  "message": os.environ["MSG"].strip(),
  "since": now.isoformat().replace("+00:00", "Z"),
  "eta_at": (now + dt.timedelta(seconds=int(eta))).isoformat().replace("+00:00", "Z") if eta else None,
  "build": os.environ["BUILD"],
}, ensure_ascii=False))'
}
write_notice() { # <message>
  local eta_s="" json
  [[ -n "$ETA" ]] && eta_s="$(eta_seconds "$ETA")"
  json="$(notice_json "$1" "$eta_s")"
  if [[ $DRY_RUN == 1 ]]; then say "would write $NOTICE_DIR/notice.json: $json"; return; fi
  printf '%s\n' "$json" | ssh "$VM" "cat > '$NOTICE_DIR/.notice.json.tmp' && mv '$NOTICE_DIR/.notice.json.tmp' '$NOTICE_DIR/notice.json'" \
    || die "could not write the notice (is $NOTICE_DIR there? run deploy/setup-blue-green.sh)"
  NOTICE_POSTED=1
  say "notice posted: $json"
}
clear_notice() {
  if [[ $DRY_RUN == 1 ]]; then say "would remove $NOTICE_DIR/notice.json"; return; fi
  ssh -n "$VM" "rm -f '$NOTICE_DIR/notice.json'" && say "notice cleared"
}

if [[ -n "$NOTICE_ONLY" ]]; then write_notice "$NOTICE_ONLY"; exit 0; fi
if [[ $CLEAR_ONLY == 1 ]]; then clear_notice; exit 0; fi

# ---- which colour is live -----------------------------------------------------
SETUP_HINT="blue/green is not set up on the VM — run deploy/setup-blue-green.sh once (README \"Deploy\" has the one-liner)"
active_conf="$(ssh -n "$VM" "cat '$ACTIVE_CONF' 2>/dev/null || true")"
live_port="$(printf '%s\n' "$active_conf" | sed -nE 's/^[[:space:]]*server[[:space:]]+127\.0\.0\.1:([0-9]+)[[:space:]]*;.*$/\1/p' | head -1)"
case "$live_port" in
  "$BLUE_PORT")  LIVE=blue;  LIVE_DIR="$BLUE_DIR";  LIVE_APP="$BLUE_APP"
                 NEXT=green; NEXT_DIR="$GREEN_DIR"; NEXT_APP="$GREEN_APP"; NEXT_PORT="$GREEN_PORT" ;;
  "$GREEN_PORT") LIVE=green; LIVE_DIR="$GREEN_DIR"; LIVE_APP="$GREEN_APP"
                 NEXT=blue;  NEXT_DIR="$BLUE_DIR";  NEXT_APP="$BLUE_APP";  NEXT_PORT="$BLUE_PORT" ;;
  *) die "$SETUP_HINT (no live server line in $ACTIVE_CONF)" ;;
esac
LIVE_PORT="$live_port"
say "live: $LIVE ($LIVE_APP :$LIVE_PORT) → deploying $GIT_SHA into $NEXT ($NEXT_APP :$NEXT_PORT, $NEXT_DIR)"

[[ -n "$MESSAGE" ]] && write_notice "$MESSAGE"

# ---- 1. stop the target colour (it is the idle backup) ---------------------------
if [[ $DRY_RUN == 0 ]]; then
  say "stop $NEXT_APP (idle backup) before replacing its tree"
  ssh -n "$VM" "pm2 stop '$NEXT_APP' >/dev/null 2>&1 || true"
fi

# ---- 2. rsync + build into the target dir ------------------------------------------
RSYNC_FLAGS=(-az --delete)
[[ $DRY_RUN == 1 ]] && RSYNC_FLAGS+=(--dry-run -v)
RSYNC_EXCLUDES=(
  --exclude node_modules
  --exclude .next
  --exclude .env.local
  --exclude .git
  --exclude .claude
  --exclude .agent-memory
  --exclude storage
  --exclude tmp
  --exclude .playwright-mcp
  --exclude '/*.png'
)
say "rsync $SRC_DIR/ → $VM:$NEXT_DIR/"
rsync "${RSYNC_FLAGS[@]}" "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/" "$VM:$NEXT_DIR/"
# pm2's mw-voiceprint sidecar runs straight from BLUE's voiceprint/ (it is not
# restarted here, same as before blue/green) — keep that copy current too.
if [[ "$NEXT" != blue ]]; then
  say "rsync voiceprint/ → $VM:$BLUE_DIR/voiceprint/ (the mw-voiceprint sidecar's home)"
  rsync "${RSYNC_FLAGS[@]}" "${RSYNC_EXCLUDES[@]}" "$SRC_DIR/voiceprint/" "$VM:$BLUE_DIR/voiceprint/"
fi

if [[ $DRY_RUN == 1 ]]; then
  say "dry run — would then:"
  say "  build in $NEXT_DIR (BUILD_ID=$BUILD_ID)"
  say "  touch $LIVE_DIR/.mw-draining and $NEXT_DIR/.mw-draining (background jobs paused in both)"
  say "  pm2 restart $NEXT_APP; health-check 127.0.0.1:$NEXT_PORT (/api/health 204, /login 302)"
  say "  $ACTIVE_CONF → 127.0.0.1:$NEXT_PORT live, 127.0.0.1:$LIVE_PORT backup; nginx -t && nginx -s reload"
  say "  wait ${DRAIN_GRACE_S}s + until no AI run under $LIVE_DIR/node_modules; pm2 stop $LIVE_APP; pm2 save"
  say "  rm $NEXT_DIR/.mw-draining (background jobs resume in $NEXT)"
  if [[ $KEEP_NOTICE == 1 ]]; then say "  keep the notice"; else say "  remove the notice (if any)"; fi
  say "dry run only, stopping."
  exit 0
fi

BUILD_LOG="/tmp/mw-deploy-build-$NEXT.log"
say "install + build in $NEXT_DIR (BUILD_ID=$BUILD_ID, log $BUILD_LOG on the VM) — the live $LIVE tree is untouched"
# The build writes to a file on the VM and the tail is read after it exits:
# piping the ssh session's stdout hung once (2026-09-22 16:39 SGT — the build
# had finished and BUILD_ID was written, but a child kept the pipe open and
# pm2 was never restarted). `-n` keeps ssh off our stdin as well.
# The target's drain file goes in first: it must boot passive (step 3 above).
ssh -n "$VM" "export PATH=\"\$HOME/.bun/bin:\$PATH\" BUILD_ID='$BUILD_ID' && cd '$NEXT_DIR' && touch .mw-draining \
  && { bun install && bun run build; } > '$BUILD_LOG' 2>&1 < /dev/null; rc=\$?; tail -5 '$BUILD_LOG'; exit \$rc" \
  || die "build failed in $NEXT_DIR — nothing switched, $LIVE still live (full log: ssh $VM cat $BUILD_LOG)"

# ---- 3. pause background jobs: the live colour stops starting them ------------------------------
say "drain $LIVE ($LIVE_DIR/.mw-draining): it stops starting background passes, keeps serving"
ssh -n "$VM" "touch '$LIVE_DIR/.mw-draining'"
# Undo for every failure before the flip: the live colour resumes, the target stops.
rollback() { ssh -n "$VM" "rm -f '$LIVE_DIR/.mw-draining'; pm2 stop '$NEXT_APP' >/dev/null 2>&1 || true" || true; }

# ---- 4. start + health-check the target on its own port ---------------------------------------
say "pm2 restart $NEXT_APP (boots passive)"
ssh -n "$VM" "pm2 restart '$NEXT_APP' --update-env >/dev/null && pm2 ls | grep -E ' $NEXT_APP '" \
  || { rollback; die "pm2 could not start $NEXT_APP — $LIVE still live"; }

say "health check 127.0.0.1:$NEXT_PORT"
ok=0
codes="000 000"
for i in $(seq 1 45); do
  codes="$(ssh -n "$VM" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:$NEXT_PORT/api/health; echo -n ' '; curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:$NEXT_PORT/login" || echo "000 000")"
  if [[ "$codes" == "204 302" ]]; then ok=1; break; fi
  if [[ $((i % 5)) == 0 ]]; then say "  not yet ($codes: /api/health, /login) — $i/45"; fi
  sleep 2
done
if [[ $ok != 1 ]]; then
  ssh -n "$VM" "pm2 logs '$NEXT_APP' --nostream --lines 40" || true
  rollback
  die "$NEXT_APP did not pass health on :$NEXT_PORT (last: $codes) — stopped; $LIVE still live, nothing switched"
fi
say "  $NEXT healthy (/api/health 204, /login 302)"

# ---- 5. flip nginx ------------------------------------------------------------------------------
flip() { # <live port> <backup port>
  ssh -n "$VM" "set -e
    printf '# Written by deploy.sh (blue/green) $BUILD_ID. Live colour first; the other is backup.\nserver 127.0.0.1:$1;\nserver 127.0.0.1:$2 backup;\n' | sudo tee '$ACTIVE_CONF.new' >/dev/null
    sudo cp -p '$ACTIVE_CONF' '$ACTIVE_CONF.prev'
    sudo mv '$ACTIVE_CONF.new' '$ACTIVE_CONF'
    if sudo nginx -t 2>/tmp/mw-nginx-t.log; then sudo nginx -s reload; else sudo mv '$ACTIVE_CONF.prev' '$ACTIVE_CONF'; cat /tmp/mw-nginx-t.log >&2; exit 1; fi"
}
say "nginx: $NEXT live (:$NEXT_PORT), $LIVE backup (:$LIVE_PORT)"
flip "$NEXT_PORT" "$LIVE_PORT" || { rollback; die "nginx -t refused the flip — $ACTIVE_CONF restored, $LIVE still live"; }

sleep 2
code="$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "$PUBLIC/api/health" || echo 000)"
login="$(curl -sk -o /dev/null -m 10 -w '%{http_code}' "$PUBLIC/login" || echo 000)"
say "public check: /api/health → $code, /login → $login"
if [[ "$code" != "204" || ( "$login" != "302" && "$login" != "200" ) ]]; then
  say "public check failed — flipping back to $LIVE"
  flip "$LIVE_PORT" "$NEXT_PORT" || echo "WARNING: the flip back failed too — check $ACTIVE_CONF on the VM by hand" >&2
  rollback
  die "the public URL did not answer through $NEXT (/api/health $code, /login $login) — flipped back, $LIVE live again"
fi

# ---- 6. retire the old colour -------------------------------------------------------------------
say "grace ${DRAIN_GRACE_S}s for requests still in flight on $LIVE"
sleep "$DRAIN_GRACE_S"
# A stop kills in-flight Agent SDK runs (a report killed this way stays failed —
# reports are never swept). Only THIS colour's runs count: the SDK's CLI child
# runs from <dir>/node_modules/@anthropic-ai/claude-agent-sdk*, so the path
# separates it from darth-chat's (/opt/darth-chat/…) and the new colour's.
# The [k] keeps the remote shell from matching itself.
AI_PATTERN="$LIVE_DIR/node_modules/@anthropic-ai/claude-agent-sd[k]"
activate() { ssh -n "$VM" "rm -f '$NEXT_DIR/.mw-draining'"; }
if [[ "${DEPLOY_FORCE:-}" != "1" ]]; then
  live_runs=0
  for i in $(seq 1 60); do
    live_runs=$(ssh -n "$VM" "pgrep -fc '$AI_PATTERN' || true")
    [[ "$live_runs" == "0" ]] && break
    say "$live_runs AI run(s) live in $LIVE — waiting before stopping it ($i/60, 15 s)"
    if [[ $i == 1 ]]; then ssh -n "$VM" "pgrep -fa '$AI_PATTERN' | cut -c1-200" || true; fi
    sleep 15
  done
  if [[ "$live_runs" != "0" ]]; then
    # Background jobs cannot stay paused forever: start them in the new colour.
    activate
    echo "AI runs still live in $LIVE after 15 min. $NEXT is live and its background jobs are on;" >&2
    echo "$LIVE keeps running as a drained backup. Stop it when its runs end:" >&2
    echo "  ssh $VM 'pm2 stop $LIVE_APP && pm2 save'" >&2
    [[ $KEEP_NOTICE == 1 ]] || clear_notice
    exit 1
  fi
fi

say "pm2 stop $LIVE_APP; pm2 save"
ssh -n "$VM" "pm2 stop '$LIVE_APP' >/dev/null && pm2 save >/dev/null && pm2 ls | grep -E 'meeting-whisperer'" \
  || echo "WARNING: pm2 stop/save of $LIVE_APP reported an error — check pm2 ls on the VM" >&2

# ---- 7. background jobs on in the new colour ------------------------------------------------------
say "activate $NEXT: rm $NEXT_DIR/.mw-draining (its skipped background jobs run within 10 s)"
activate

if [[ $KEEP_NOTICE == 1 ]]; then say "notice kept (--keep-notice)"; else clear_notice; fi
say "deployed OK: $NEXT live on :$NEXT_PORT (BUILD_ID=$BUILD_ID); $LIVE stopped"
