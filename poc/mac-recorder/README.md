# mac-recorder — Darth Recorder (menu-bar helper) + ScreenCaptureKit POC

Native macOS side of Darth Meetings recording (the "Swift tray" angle from Darth Chat
92c0134a). Three targets in one SwiftPM package:

- **RecorderCore** — ScreenCaptureKit → AVAssetWriter capture (display or window + system
  audio → H.264/AAC `.mp4`). No BlackHole, no virtual devices, no device switching.
- **darth-tray** — the menu-bar app "Darth Recorder": detects calls, shows a Notion-style
  banner, records, serves the Meetings PWA over `ws://127.0.0.1:47800`, and updates itself
  from `cli.darth-internal.trames.io` (see *Auto-update*).
- **recorder-poc** — the original CLI, kept for quick capture experiments.

## Darth Recorder (tray) — build, release, publish

    ./make-app.sh                      # dev: Apple Development signature → ~/Applications, relaunch
    ./make-app.sh --release            # Developer ID + hardened runtime + notarize + staple → dist/DarthRecorder-<ver>.zip
    ./dist-scripts/deploy-to-dot6.sh   # publish zip + version.json + installer to cli.darth-internal.trames.io

Colleagues install with
`curl -fsSL https://cli.darth-internal.trames.io/setup-darth-recorder.sh | bash`
(Tailnet-only; macOS 14+; verifies sha256 + notarization before installing to /Applications,
re-run to update). Served files live in `/var/www/cli-dist/{setup-darth-recorder.sh,darth-recorder/}`
on .6 — a serve destination, no git there.

Signing facts (2026-09-15): team **SMX3ZQ2226 TRAMES PRIVATE LIMITED**; release identity
`Developer ID Application: TRAMES PRIVATE LIMITED (SMX3ZQ2226)`; notarization uses the
keychain profile `darth-notary` (app-specific password for mail@alokrajiv.com, stored with
`xcrun notarytool store-credentials`). First notarization accepted in ~2 min. Version comes
from `let VERSION` in `Sources/darth-tray/main.swift` — bump it before a release.
TCC (Screen Recording) is keyed to the code requirement: dev-signed and Developer-ID-signed
builds are DIFFERENT grants (one extra toggle when switching), but each survives its own
rebuilds. Apple membership renews 14 Apr 2027 with auto-renew off — a lapse breaks notarization.
Log: `~/Library/Logs/DarthRecorder/tray.log`. Recordings: `~/Movies/Darth Recorder/`.

## Auto-update (`Updater.swift`, since 0.1.4)

The tray updates itself — no Sparkle (the bundle is hand-assembled by `make-app.sh`, so
embedding Sparkle's framework + XPC services is not worth it). It reuses what the installer
already publishes: `https://cli.darth-internal.trames.io/darth-recorder/version.json`
(`version`, `zip`, `sha256`, `min_macos`, …) and the zip next to it.

**Flow.** Check 30 s after launch and every 6 h, plus **Check for Updates…** in the menu
(reports "You're up to date (x.y.z)" via the banner, or an error banner). Off the Tailnet the
periodic check fails silently (one debug line in tray.log, no banner). When `version` is
semver-newer than `let VERSION`: download the zip to
`~/Library/Caches/io.trames.darth.recorder/updates/<ver>/`, then **verify** — sha256 equals
version.json's → `ditto -x -k` → `codesign --verify --deep --strict` → `codesign -dv` shows
`TeamIdentifier=SMX3ZQ2226` → `spctl --assess --type execute` (notarized) → the bundle's
`CFBundleIdentifier` + `CFBundleShortVersionString` match. Any failure → `updater: REFUSED — …`
in tray.log, staging dir deleted, nothing installed.

**Install policy.** Idle (no recording, no detected call) → installs immediately. Busy → the
update stays staged; a banner offers "Install and restart" (stops the recording first) and
otherwise it installs the moment the recording stops / the call ends. The menu item turns into
"Install x.y.z and restart" while staged. A loop guard refuses to *auto*-install the same
version twice within an hour (manual install still works).

**Install mechanics.** The app writes `install.sh` into the staging dir, launches it detached
(`nohup bash …`, output appended to tray.log) and terminates. The helper waits for our pid,
moves `/Applications/Darth Recorder.app` to `~/.Trash/Darth Recorder <old>.app` (or `rm -rf`
if the move fails), moves the staged bundle into place (`ditto` fallback; restores the old one
if both fail), `open`s it and removes the staging dir. If the app does not run from
`/Applications` it installs over wherever it runs from (`Bundle.main.bundleURL`). The
Developer ID code requirement is unchanged, so the Screen Recording grant survives. After the
relaunch the banner says "Darth Recorder updated to x.y.z". The PWA status snapshot carries
`update_available` / `update_staged` (version string or null).

**Testing.** `{cmd:"check_update"}` over `ws://127.0.0.1:47800` = the menu item (drive it with a
bun one-liner: `new WebSocket(...)`, send the JSON, print messages). Env overrides read at
launch: `DARTH_TRAY_UPDATE_INTERVAL=<seconds>` (first check after min(30, interval)),
`DARTH_TRAY_UPDATE_URL=file:///…/version.json` (zip resolves relative to it) — e.g. tamper the
`sha256` in a local copy, `open -n "/Applications/Darth Recorder.app" --env
DARTH_TRAY_UPDATE_URL=file:///tmp/v.json --env DARTH_TRAY_UPDATE_INTERVAL=5` and expect a
`REFUSED — sha256 mismatch` line. E2E proof (2026-09-15): a running 0.1.4 detected the
published 0.1.5, verified, swapped the bundle and relaunched as 0.1.5 with no human action.

**Call detection** (`CallDetector.swift`): every 1.5 s poll Core Audio's process objects
(`kAudioHardwarePropertyProcessObjectList`) for `kAudioProcessPropertyIsRunningInput` —
i.e. who has the microphone open. Walk the pid up to its Dock-visible app (Teams WebView →
Microsoft Teams, Chrome Helper → Google Chrome), classify by bundle id, and for browsers use
the window title to tell Meet / Teams-web / Zoom-web apart. 2 polls to start (mic-permission
flickers), 3 polls to end. Needs NO mic permission. System daemons (`/System`, `/usr`) are
ignored — `replayd` opens input while we ourselves record.

**PWA protocol** (`LocalServer.swift`, Network.framework WebSocket server on loopback).
Every message is a full status snapshot + `type`:
`status | call_started | call_ended | recording_started | recording_stopped`, with `calls[]`,
`recording`, `recording_since/path/label`, `screen_recording_permission`, `version`,
`update_available`, `update_staged`.
Commands from the page: `{cmd:"start", pid?}`, `{cmd:"stop"}`, `{cmd:"status"}`, and the
test hooks `{cmd:"simulate_call", kind}` / `{cmd:"end_simulated"}` / `{cmd:"check_update"}`. The PWA side is
`src/lib/companion/companion-client.ts` + `src/components/companion-banner.tsx` (mounted in
the root layout; renders nothing unless a tray answers). TODO before this leaves POC:
pairing token + Origin allow-list; today any local page can drive the recorder.

**Recording** = display filter of the display containing the call's window (all windows +
all system audio), 5 fps. Mic is NOT captured yet.

**Verified 2026-09-15:** simulated + real (ffmpeg mic) detection; banner; PWA banner →
Record → 30 s display recording (3456x2234, 148 frames, AAC track) → Stop from PWA → file.

## CLI POC (`recorder-poc`)

## Build / run

    swift build -c release
    ./.build/release/recorder-poc --list                       # displays / apps / on-screen windows
    ./.build/release/recorder-poc --seconds 12 --out out.mp4   # largest on-screen Microsoft Teams window
    ./.build/release/recorder-poc --window "Zoom" --seconds 30
    ./.build/release/recorder-poc --display --seconds 10       # main display (CGMainDisplayID)
    ./.build/release/recorder-poc --display-id 2 --seconds 10
    flags: --fps N (default 5) · --no-audio · Ctrl-C stops early and finalises the file

Requires macOS 14+ (uses `SCContentFilter.contentRect` / `pointPixelScale`). Built and
verified on macOS 15.0.1 / Xcode SDK 15.2 / Swift 6.0.3 (language mode 5).

## Verified 2026-09-15

| test | result |
|---|---|
| Teams window, 12 s, 5 fps | 2880x2008 video, 65 frames, 13.0 s; audio track present but silent (Teams was idle) |
| main display, 10 s, 5 fps, `afplay` sounds during capture | 3456x2234 video, 54 frames; system audio captured, peak -8.9 dB |

## Things learned (keep)

- **TCC**: a terminal-launched binary gets Screen Recording attributed to the *terminal app*
  (Ghostty here). `CGPreflightScreenCaptureAccess()` answers without prompting;
  `CGRequestScreenCaptureAccess()` triggers the system prompt. The grant applied to new child
  processes without restarting the terminal. A real tray app needs its own stable code
  signature (Developer ID) or the grant is lost on every rebuild.
- **`SCContentFilter(desktopIndependentWindow:)` asserts `CGS_REQUIRE_INIT` in a bare CLI.**
  Touch `NSApplication.shared` first (with `.prohibited` activation policy so no Dock icon).
  Display filters do not need this.
- **SCK only delivers `.complete` frames when pixels change.** A static screen yields ~2 frames
  in 10 s, so the mp4 video track was 0.3 s long. `.idle` frames still arrive at the configured
  interval; re-appending the last CVPixelBuffer at the idle frame's PTS (via
  `AVAssetWriterInputPixelBufferAdaptor`) gives a constant-fps track.
- **Audio scope follows the filter.** A window filter only carries the owning app's audio
  (Teams silent → -91 dB); a display filter carries all system audio. For a meeting recorder
  prefer `SCContentFilter(display:including:[teamsApp], exceptingWindows: [])` or the plain
  display filter, then decide window vs display for *video* separately.
- `content.displays.first` is not the main display on a multi-monitor Mac; match
  `CGMainDisplayID()` (or the display containing the target window).
- Audio arrives as 48 kHz stereo LPCM buffers roughly every 20 ms (~50/s); AAC via
  AVAssetWriter is fine in real time. `excludesCurrentProcessAudio = true` avoids feedback.

## Not done yet (next steps)

1. Mic as a second audio track (`AVAudioEngine` input tap, or SCK's `.microphone` output on
   macOS 15) — keep it separate from system audio, never mix at capture.
2. Segmenting: fragmented MP4 / 30 s segments into `pending/`, uploader loop with retry,
   upload into the Meetings backend (chunked /api/uploads) — today files stay in ~/Movies.
3. Pairing token + Origin allow-list on the local socket; launch-at-login (LaunchAgent).
4. Auto-stop when the detected call ends (currently a warning banner only).
5. Sign with the Trames Developer ID + notarize for colleagues (cert expires 14 Apr 2027,
   auto-renew off). Windows companion (C#/.NET, WGC + WASAPI process loopback).
