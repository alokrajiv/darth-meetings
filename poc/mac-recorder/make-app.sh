#!/usr/bin/env bash
# Build darth-tray → signed "Darth Recorder.app". Two modes:
#   ./make-app.sh                 dev: Apple Development identity, install to ~/Applications, relaunch
#   ./make-app.sh --release       Developer ID + hardened runtime + notarize + staple → dist/DarthRecorder-<ver>.zip
#   ./make-app.sh --no-run        dev build without relaunch
# Env: DARTH_SIGN_IDENTITY (override identity), DARTH_NOTARY_PROFILE (default darth-notary).
set -euo pipefail
cd "$(dirname "$0")"
APP_NAME="Darth Recorder"
BUNDLE_ID="io.trames.darth.recorder"
VERSION="$(grep -o 'let VERSION = "[^"]*"' Sources/darth-tray/main.swift | cut -d'"' -f2)"
DIST="dist/$APP_NAME.app"
INSTALL="$HOME/Applications/$APP_NAME.app"
MODE="${1:-dev}"

if [[ "$MODE" == "--release" ]]; then
  IDENTITY="${DARTH_SIGN_IDENTITY:-Developer ID Application: TRAMES PRIVATE LIMITED (SMX3ZQ2226)}"
else
  IDENTITY="${DARTH_SIGN_IDENTITY:-Apple Development: Alok Rajiv (PPG7RNP59C)}"
fi

swift build -c release --product darth-tray 2>&1 | tail -2
rm -rf "$DIST"
mkdir -p "$DIST/Contents/MacOS" "$DIST/Contents/Resources"
cp .build/release/darth-tray "$DIST/Contents/MacOS/darth-tray"
# App icon = the Darth Meetings PWA icon (public/icons/icon-512.png) as .icns
ICONSRC="../../public/icons/icon-512.png"
if [[ -f "$ICONSRC" ]]; then
  rm -rf dist/AppIcon.iconset && mkdir -p dist/AppIcon.iconset
  for sz in 16 32 128 256 512; do
    sips -z $sz $sz "$ICONSRC" --out "dist/AppIcon.iconset/icon_${sz}x${sz}.png" >/dev/null
    dbl=$((sz*2)); sips -z $dbl $dbl "$ICONSRC" --out "dist/AppIcon.iconset/icon_${sz}x${sz}@2x.png" >/dev/null
  done
  iconutil -c icns dist/AppIcon.iconset -o "$DIST/Contents/Resources/AppIcon.icns"
  rm -rf dist/AppIcon.iconset
fi
cat > "$DIST/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>darth-tray</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M)</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Darth Recorder records your side of meetings.</string>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>CFBundleURLTypes</key>
  <array><dict>
    <key>CFBundleURLName</key><string>Darth Recorder</string>
    <key>CFBundleURLSchemes</key><array><string>darth-recorder</string></array>
  </dict></array>
</dict></plist>
PLIST

if [[ "$MODE" == "--release" ]]; then
  # Hardened runtime is required for notarization. SCK/AVFoundation need no extra entitlements
  # beyond the TCC usage strings; keep the entitlement file minimal.
  cat > dist/entitlements.plist <<ENT
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
ENT
  codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --options runtime --timestamp \
    --entitlements dist/entitlements.plist "$DIST"
  codesign --verify --deep --strict --verbose=2 "$DIST" 2>&1 | tail -2
  ZIP="dist/DarthRecorder-$VERSION.zip"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$DIST" "$ZIP"
  PROFILE="${DARTH_NOTARY_PROFILE:-darth-notary}"
  echo "==> notarizing $ZIP with profile $PROFILE (this takes 1–5 min)"
  xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait 2>&1 | tail -6
  xcrun stapler staple "$DIST" 2>&1 | tail -1
  # Re-zip AFTER stapling so the ticket ships inside the archive.
  rm -f "$ZIP"
  ditto -c -k --keepParent "$DIST" "$ZIP"
  echo "==> Gatekeeper assessment:"
  spctl --assess --type execute --verbose=2 "$DIST" 2>&1 | tail -2
  shasum -a 256 "$ZIP"
  echo "release ready: $ZIP"
  exit 0
fi

codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --timestamp=none "$DIST"
codesign -dv "$DIST" 2>&1 | grep -E "^(Identifier|TeamIdentifier|Authority)=" | head -3

if [[ "$MODE" != "--no-run" ]]; then
  pkill -x darth-tray 2>/dev/null && sleep 0.5 || true
  mkdir -p "$HOME/Applications"
  rm -rf "$INSTALL"
  cp -R "$DIST" "$INSTALL"
  open "$INSTALL"
  echo "launched $INSTALL — log: ~/Library/Logs/DarthRecorder/tray.log"
fi
