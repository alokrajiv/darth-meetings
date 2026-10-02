#!/usr/bin/env bash
# One-time (idempotent) VM setup for blue/green deploys of Darth Meetings.
# Run ON THE VM as azureuser (passwordless sudo), from a folder holding this
# script + nginx-meetings.conf + maintenance.html. From the laptop:
#
#   ssh azureuser@172.17.0.6 'mkdir -p /tmp/mw-setup' \
#     && scp deploy/setup-blue-green.sh deploy/nginx-meetings.conf deploy/maintenance.html \
#            azureuser@172.17.0.6:/tmp/mw-setup/ \
#     && ssh -t azureuser@172.17.0.6 'bash /tmp/mw-setup/setup-blue-green.sh'
#
# What it does (each step skips itself when already done):
#   1. ~/apps/meeting-whisperer-green with .env.local and storage/ SYMLINKED to
#      blue's (one config, one media store, one DB for both colours);
#   2. /var/www/mw-maintenance (nginx's notice.json + maintenance.html);
#   3. /etc/nginx/mw-active.conf = blue live (3002), green backup (3012) — only
#      when the file does not exist yet; afterwards deploy.sh owns it;
#   4. the vhost from nginx-meetings.conf → /etc/nginx/sites-available/meetings
#      (previous copy kept as /etc/nginx/mw-meetings-vhost.bak-<ts>), nginx -t,
#      reload; restored when nginx -t fails;
#   5. pm2 app `meeting-whisperer-green` with blue's exact command, port 3012,
#      cwd = the green dir — registered and left STOPPED (it has no build yet;
#      the first deploy builds and starts it), then `pm2 save`.
#
# Safe to re-run: it never touches blue's process, files or the live upstream.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BLUE_DIR="$HOME/apps/meeting-whisperer"
GREEN_DIR="$HOME/apps/meeting-whisperer-green"
BLUE_APP="meeting-whisperer"
GREEN_APP="meeting-whisperer-green"
BLUE_PORT=3002
GREEN_PORT=3012
ACTIVE_CONF="/etc/nginx/mw-active.conf"
VHOST="/etc/nginx/sites-available/meetings"
VHOST_LINK="/etc/nginx/sites-enabled/meetings"
NOTICE_DIR="/var/www/mw-maintenance"
export PATH="$HOME/.bun/bin:$PATH"

say() { printf '==> %s\n' "$*"; }
die() { printf 'SETUP FAILED: %s\n' "$*" >&2; exit 1; }

for f in nginx-meetings.conf maintenance.html; do
  [[ -f "$HERE/$f" ]] || die "$HERE/$f missing — copy it next to this script (see the header)"
done
[[ -d "$BLUE_DIR" ]] || die "$BLUE_DIR does not exist"
[[ -f "$BLUE_DIR/.env.local" ]] || die "$BLUE_DIR/.env.local missing"
[[ -d "$BLUE_DIR/storage" ]] || die "$BLUE_DIR/storage missing"
command -v pm2 >/dev/null || die "pm2 not on PATH"
command -v node >/dev/null || die "node not on PATH (needed to read pm2's process list)"
pm2 describe "$BLUE_APP" >/dev/null 2>&1 || die "pm2 app $BLUE_APP not found"

# --- 1. green dir + shared state ----------------------------------------------
say "green dir $GREEN_DIR"
mkdir -p "$GREEN_DIR"
link_shared() { # <name>
  local name="$1" target="$BLUE_DIR/$1" here="$GREEN_DIR/$1"
  if [[ -L "$here" ]]; then
    [[ "$(readlink "$here")" == "$target" ]] || die "$here points at $(readlink "$here"), expected $target"
    say "  $name → blue's (already linked)"
  elif [[ -e "$here" ]]; then
    die "$here exists and is not a symlink — move it away; green must share blue's $name"
  else
    ln -s "$target" "$here"
    say "  $name → $target (linked)"
  fi
}
link_shared .env.local
# The media store is shared through an ABSOLUTE MW_STORAGE_DIR in the (shared)
# .env.local — never through a storage/ symlink in green: Turbopack's build
# traces `storage/` from audio-storage.ts, follows the symlink into blue's tree
# and fails with "Symlink … points out of the filesystem root" (seen 2026-10-02).
if [[ -L "$GREEN_DIR/storage" ]]; then rm "$GREEN_DIR/storage"; say "  removed the old storage symlink in green"; fi
[[ -e "$GREEN_DIR/storage" ]] && die "$GREEN_DIR/storage exists — green must not have its own media store; move it away"
storage_env="$(grep -E '^[[:space:]]*MW_STORAGE_DIR=' "$BLUE_DIR/.env.local" | tail -1 | cut -d= -f2- || true)"
if [[ -z "$storage_env" ]]; then
  printf '\n# blue/green: one absolute media store for both colours (green has no storage/ dir)\nMW_STORAGE_DIR=%s/storage\n' "$BLUE_DIR" >> "$BLUE_DIR/.env.local"
  storage_env="$BLUE_DIR/storage"
  say "  MW_STORAGE_DIR=$storage_env appended to .env.local (blue reads the same path relatively today)"
elif [[ "$storage_env" != /* ]]; then
  die "MW_STORAGE_DIR in .env.local is relative ($storage_env) — make it absolute so both colours share one store"
else
  say "  MW_STORAGE_DIR=$storage_env (absolute, shared)"
fi

# --- 2. maintenance files -------------------------------------------------------
say "maintenance dir $NOTICE_DIR"
sudo mkdir -p "$NOTICE_DIR"
sudo chown "$(id -un)":"$(id -gn)" "$NOTICE_DIR"
chmod 755 "$NOTICE_DIR"
install -m 644 "$HERE/maintenance.html" "$NOTICE_DIR/maintenance.html"
say "  maintenance.html installed (notice.json is written only by deploy.sh --message/--notice)"

# --- 3. active-colour include -----------------------------------------------------
if [[ -f "$ACTIVE_CONF" ]]; then
  say "$ACTIVE_CONF exists — left as is:"
  sed 's/^/      /' "$ACTIVE_CONF"
else
  say "$ACTIVE_CONF → blue live, green backup"
  printf '# Written by deploy.sh (blue/green). Live colour first; the other is backup.\nserver 127.0.0.1:%s;\nserver 127.0.0.1:%s backup;\n' \
    "$BLUE_PORT" "$GREEN_PORT" | sudo tee "$ACTIVE_CONF" >/dev/null
fi

# --- 4. vhost ---------------------------------------------------------------------
if [[ -f "$VHOST" ]] && cmp -s "$HERE/nginx-meetings.conf" "$VHOST"; then
  say "vhost $VHOST already current"
else
  backup=""
  if [[ -f "$VHOST" ]]; then
    # Outside sites-enabled/ and sites-available/ so nginx never loads it.
    backup="/etc/nginx/mw-meetings-vhost.bak-$(date +%Y%m%d-%H%M%S)"
    sudo cp -p "$VHOST" "$backup"
    say "vhost backup → $backup"
  fi
  sudo install -m 644 "$HERE/nginx-meetings.conf" "$VHOST"
  [[ -L "$VHOST_LINK" ]] || sudo ln -s "$VHOST" "$VHOST_LINK"
  if ! sudo nginx -t; then
    if [[ -n "$backup" ]]; then sudo cp -p "$backup" "$VHOST"; say "nginx -t failed — previous vhost restored"; fi
    die "nginx -t failed with the new vhost"
  fi
  sudo nginx -s reload
  say "vhost installed, nginx reloaded"
fi

# --- 5. green pm2 app ----------------------------------------------------------------
if pm2 describe "$GREEN_APP" >/dev/null 2>&1; then
  say "pm2 app $GREEN_APP already registered"
else
  # Mirror blue's exact command (exec path, interpreter, args) with the port swapped.
  spec="$(pm2 jlist | BLUE_APP="$BLUE_APP" BLUE_DIR="$BLUE_DIR" GREEN_DIR="$GREEN_DIR" BLUE_PORT="$BLUE_PORT" GREEN_PORT="$GREEN_PORT" node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const list = JSON.parse(s.slice(s.indexOf("[")));
      const p = list.find((x) => x.name === process.env.BLUE_APP);
      if (!p) { console.error("blue not in pm2 jlist"); process.exit(1); }
      const e = p.pm2_env;
      let args = Array.isArray(e.args) ? e.args.map(String) : String(e.args || "").split(" ").filter(Boolean);
      const hits = args.filter((a) => a.includes(process.env.BLUE_PORT)).length;
      if (hits !== 1) { console.error("blue args " + JSON.stringify(args) + " do not carry the port exactly once"); process.exit(1); }
      // A path inside the blue tree (e.g. its node_modules/.bin/next) must become the green one.
      const swap = (a) => a.split(process.env.BLUE_DIR + "/").join(process.env.GREEN_DIR + "/");
      args = args.map((a) => swap(a.split(process.env.BLUE_PORT).join(process.env.GREEN_PORT)));
      console.log([swap(e.pm_exec_path), e.exec_interpreter || "none", ...args].join("\n"));
    });
  ')" || die "could not read blue's pm2 command — register $GREEN_APP by hand (same as blue, --port $GREEN_PORT, --cwd $GREEN_DIR)"
  mapfile -t parts <<<"$spec"
  exec_path="${parts[0]}"; interp="${parts[1]}"; args=("${parts[@]:2}")
  say "pm2 start $exec_path --name $GREEN_APP --cwd $GREEN_DIR --interpreter $interp -- ${args[*]}"
  pm2 start "$exec_path" --name "$GREEN_APP" --cwd "$GREEN_DIR" --interpreter "$interp" -- "${args[@]}"
  # No build in the green dir yet: keep it stopped until the first deploy.
  pm2 stop "$GREEN_APP"
fi
pm2 save

say "done. State:"
sed 's/^/      /' "$ACTIVE_CONF"
pm2 ls | grep -E "meeting-whisperer" || true
probe() { curl -s -o /dev/null -w '%{http_code}' --resolve meetings.darth-internal.trames.io:443:127.0.0.1 "https://meetings.darth-internal.trames.io$1" || true; }
code=$(probe /__notice.json)
say "https://meetings…/__notice.json → $code (404 = no notice, expected)"
code=$(probe /login)
say "https://meetings…/login → $code (302 expected — blue still serving)"
say "next: ./deploy.sh from the laptop builds + starts green, flips nginx, retires blue"
