#!/usr/bin/env bash
# Publish the notarized release (dist/DarthRecorder-<ver>.zip from ./make-app.sh --release)
# + installer to the SHARED static CLI host on .6. No git on the VM: it is a serve destination.
set -euo pipefail
cd "$(dirname "$0")/.."
VM="${DOT6_HOST:-azureuser@172.17.0.6}"
DEST=/var/www/cli-dist
BASE=https://cli.darth-internal.trames.io
VERSION="$(grep -o 'let VERSION = "[^"]*"' Sources/darth-tray/main.swift | cut -d'"' -f2)"
ZIP="dist/DarthRecorder-$VERSION.zip"
DMG="dist/DarthRecorder-$VERSION.dmg"
[[ -f "$ZIP" && -f "$DMG" ]] || { echo "missing $ZIP / $DMG — run ./make-app.sh --release first" >&2; exit 1; }
DMGSHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
spctl --assess --type execute "dist/Darth Recorder.app" >/dev/null || { echo "dist app is not notarized" >&2; exit 1; }
SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
cat > dist/version.json <<JSON
{"name":"Darth Recorder","version":"$VERSION","zip":"DarthRecorder-$VERSION.zip","sha256":"$SHA","dmg":"DarthRecorder-$VERSION.dmg","dmg_sha256":"$DMGSHA","min_macos":"14.0","published":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","installer":"$BASE/setup-darth-recorder.sh"}
JSON

scp -q "$ZIP" "$DMG" dist/version.json dist-scripts/setup-darth-recorder.sh "$VM:/tmp/"
ssh "$VM" "sudo mkdir -p $DEST/darth-recorder \
  && sudo install -m 0644 -o root -g root /tmp/DarthRecorder-$VERSION.zip $DEST/darth-recorder/DarthRecorder-$VERSION.zip \
  && sudo ln -sfn DarthRecorder-$VERSION.zip $DEST/darth-recorder/DarthRecorder-latest.zip \
  && sudo install -m 0644 -o root -g root /tmp/DarthRecorder-$VERSION.dmg $DEST/darth-recorder/DarthRecorder-$VERSION.dmg \
  && sudo ln -sfn DarthRecorder-$VERSION.dmg $DEST/darth-recorder/DarthRecorder-latest.dmg \
  && sudo install -m 0644 -o root -g root /tmp/version.json $DEST/darth-recorder/version.json \
  && sudo install -m 0644 -o root -g root /tmp/setup-darth-recorder.sh $DEST/setup-darth-recorder.sh \
  && rm -f /tmp/DarthRecorder-$VERSION.zip /tmp/DarthRecorder-$VERSION.dmg /tmp/version.json /tmp/setup-darth-recorder.sh \
  && ls -la $DEST/darth-recorder $DEST/setup-darth-recorder.sh"

# Prove what is SERVED is this checkout.
SERVED_ZIP="$(curl -fsSk --max-time 60 "$BASE/darth-recorder/DarthRecorder-$VERSION.zip" | shasum -a 256 | awk '{print $1}')"
SERVED_LATEST="$(curl -fsSk --max-time 60 "$BASE/darth-recorder/DarthRecorder-latest.zip" | shasum -a 256 | awk '{print $1}')"
[[ "$SERVED_LATEST" == "$SHA" ]] || { echo "LATEST MISMATCH served=$SERVED_LATEST local=$SHA" >&2; exit 1; }
SERVED_DMG="$(curl -fsSk --max-time 60 "$BASE/darth-recorder/DarthRecorder-latest.dmg" | shasum -a 256 | awk '{print $1}')"
[[ "$SERVED_DMG" == "$DMGSHA" ]] || { echo "DMG MISMATCH served=$SERVED_DMG local=$DMGSHA" >&2; exit 1; }
SERVED_SH="$(curl -fsSk --max-time 15 "$BASE/setup-darth-recorder.sh" | shasum -a 256 | awk '{print $1}')"
LOCAL_SH="$(shasum -a 256 dist-scripts/setup-darth-recorder.sh | awk '{print $1}')"
[[ "$SERVED_ZIP" == "$SHA" ]] || { echo "ZIP MISMATCH served=$SERVED_ZIP local=$SHA" >&2; exit 1; }
[[ "$SERVED_SH" == "$LOCAL_SH" ]] || { echo "INSTALLER MISMATCH" >&2; exit 1; }
curl -fsSk "$BASE/darth-recorder/version.json"; echo
echo "OK — published $VERSION (zip sha256 $SHA)"
echo "install: curl -fsSL $BASE/setup-darth-recorder.sh | bash"
