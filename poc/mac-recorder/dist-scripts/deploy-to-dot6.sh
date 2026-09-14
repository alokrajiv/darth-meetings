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
[[ -f "$ZIP" ]] || { echo "missing $ZIP — run ./make-app.sh --release first" >&2; exit 1; }
spctl --assess --type execute "dist/Darth Recorder.app" >/dev/null || { echo "dist app is not notarized" >&2; exit 1; }
SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
cat > dist/version.json <<JSON
{"name":"Darth Recorder","version":"$VERSION","zip":"DarthRecorder-$VERSION.zip","sha256":"$SHA","min_macos":"14.0","published":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","installer":"$BASE/setup-darth-recorder.sh"}
JSON

scp -q "$ZIP" dist/version.json dist-scripts/setup-darth-recorder.sh "$VM:/tmp/"
ssh "$VM" "sudo mkdir -p $DEST/darth-recorder \
  && sudo install -m 0644 -o root -g root /tmp/DarthRecorder-$VERSION.zip $DEST/darth-recorder/DarthRecorder-$VERSION.zip \
  && sudo install -m 0644 -o root -g root /tmp/version.json $DEST/darth-recorder/version.json \
  && sudo install -m 0644 -o root -g root /tmp/setup-darth-recorder.sh $DEST/setup-darth-recorder.sh \
  && rm -f /tmp/DarthRecorder-$VERSION.zip /tmp/version.json /tmp/setup-darth-recorder.sh \
  && ls -la $DEST/darth-recorder $DEST/setup-darth-recorder.sh"

# Prove what is SERVED is this checkout.
SERVED_ZIP="$(curl -fsSk --max-time 60 "$BASE/darth-recorder/DarthRecorder-$VERSION.zip" | shasum -a 256 | awk '{print $1}')"
SERVED_SH="$(curl -fsSk --max-time 15 "$BASE/setup-darth-recorder.sh" | shasum -a 256 | awk '{print $1}')"
LOCAL_SH="$(shasum -a 256 dist-scripts/setup-darth-recorder.sh | awk '{print $1}')"
[[ "$SERVED_ZIP" == "$SHA" ]] || { echo "ZIP MISMATCH served=$SERVED_ZIP local=$SHA" >&2; exit 1; }
[[ "$SERVED_SH" == "$LOCAL_SH" ]] || { echo "INSTALLER MISMATCH" >&2; exit 1; }
curl -fsSk "$BASE/darth-recorder/version.json"; echo
echo "OK — published $VERSION (zip sha256 $SHA)"
echo "install: curl -fsSL $BASE/setup-darth-recorder.sh | bash"
