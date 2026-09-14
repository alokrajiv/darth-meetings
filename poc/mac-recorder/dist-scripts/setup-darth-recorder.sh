#!/usr/bin/env bash
# Darth Recorder — macOS menu-bar helper for Darth Meetings.
#   curl -fsSL https://cli.darth-internal.trames.io/setup-darth-recorder.sh | bash
# Env: DARTH_RECORDER_BASE_URL (default cli host), DARTH_RECORDER_INSTALL_DIR (default /Applications,
#      falls back to ~/Applications), DARTH_RECORDER_NO_LAUNCH=1 (install only).
set -euo pipefail
BASE_URL="${DARTH_RECORDER_BASE_URL:-https://cli.darth-internal.trames.io}"
APP="Darth Recorder.app"
TMP="$(mktemp -d /tmp/darth-recorder.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "Darth Recorder is macOS-only (Windows helper: not yet)."
major="$(sw_vers -productVersion | cut -d. -f1)"
[[ "$major" -ge 14 ]] || die "needs macOS 14 (Sonoma) or newer — you have $(sw_vers -productVersion)."

say "fetching release info from $BASE_URL"
if ! curl -fsS --max-time 20 "$BASE_URL/darth-recorder/version.json" -o "$TMP/version.json"; then
  die "could not reach $BASE_URL — are you on the Trames Tailnet? (Tailscale must be connected)"
fi
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/version.json")"
ZIP="$(sed -n 's/.*"zip": *"\([^"]*\)".*/\1/p' "$TMP/version.json")"
SHA="$(sed -n 's/.*"sha256": *"\([^"]*\)".*/\1/p' "$TMP/version.json")"
[[ -n "$VERSION" && -n "$ZIP" && -n "$SHA" ]] || die "version.json is malformed"

say "downloading Darth Recorder $VERSION"
curl -fsS --max-time 300 "$BASE_URL/darth-recorder/$ZIP" -o "$TMP/$ZIP"
GOT="$(shasum -a 256 "$TMP/$ZIP" | awk '{print $1}')"
[[ "$GOT" == "$SHA" ]] || die "checksum mismatch (expected $SHA, got $GOT) — refusing to install"

say "unpacking + verifying Apple notarization"
ditto -x -k "$TMP/$ZIP" "$TMP/unpacked"
[[ -d "$TMP/unpacked/$APP" ]] || die "archive did not contain $APP"
codesign --verify --deep --strict "$TMP/unpacked/$APP" || die "code signature invalid"
spctl --assess --type execute "$TMP/unpacked/$APP" || die "Gatekeeper rejected the app (not notarized?)"

DEST="${DARTH_RECORDER_INSTALL_DIR:-/Applications}"
if [[ ! -w "$DEST" ]]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
if pgrep -x darth-tray >/dev/null 2>&1; then say "stopping the running Darth Recorder"; pkill -x darth-tray || true; sleep 1; fi
rm -rf "$DEST/$APP"
ditto "$TMP/unpacked/$APP" "$DEST/$APP"
say "installed $DEST/$APP"

if [[ "${DARTH_RECORDER_NO_LAUNCH:-0}" != "1" ]]; then
  open "$DEST/$APP"
  say "launched — look for the waveform icon in your menu bar"
fi
cat <<MSG

Next:
  1. macOS will ask for Screen Recording → allow it (System Settings › Privacy & Security ›
     Screen Recording › Darth Recorder). macOS relaunches the app after you toggle it.
  2. Open https://meetings.darth-internal.trames.io — the page shows a banner when a call
     starts (Teams, Meet, Zoom, …) with a Record button.
  Recordings land in ~/Movies/Darth Recorder. Log: ~/Library/Logs/DarthRecorder/tray.log
  Re-run this installer any time to update.
MSG
