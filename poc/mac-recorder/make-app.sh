#!/usr/bin/env bash
# Build darth-tray and wrap it in a signed .app bundle so TCC (Screen Recording) keys the
# grant to a stable code signature instead of the terminal. Then `open` it.
#   ./make-app.sh            build + bundle + sign + install to ~/Applications + (re)launch
#   ./make-app.sh --no-run   build + bundle + sign only
set -euo pipefail
cd "$(dirname "$0")"
IDENTITY="${DARTH_SIGN_IDENTITY:-Apple Development: Alok Rajiv (PPG7RNP59C)}"
APP_NAME="Darth Recorder"
BUNDLE_ID="io.trames.darth.recorder"
DIST="dist/$APP_NAME.app"
INSTALL="$HOME/Applications/$APP_NAME.app"

swift build -c release --product darth-tray 2>&1 | tail -2
rm -rf "$DIST"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"
cp .build/release/darth-tray "$DIST/Contents/MacOS/darth-tray"
cat > "$DIST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>darth-tray</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Darth Recorder records your side of meetings.</string>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict></plist>
PLIST
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --timestamp=none "$DIST"
codesign -dv "$DIST" 2>&1 | grep -E "^(Identifier|TeamIdentifier|Authority)=" | head -3

if [[ "${1:-}" != "--no-run" ]]; then
  pkill -x darth-tray 2>/dev/null && sleep 0.5 || true
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALL"
  cp -R "$DIST" "$INSTALL"
  open "$INSTALL"
  echo "launched $INSTALL — log: ~/Library/Logs/DarthRecorder/tray.log"
fi
