# mac-recorder — Darth Recorder (menu-bar helper) + ScreenCaptureKit POC

Native macOS side of Darth Meetings recording (the "Swift tray" angle from Darth Chat
92c0134a). Three targets in one SwiftPM package:

- **RecorderCore** — ScreenCaptureKit → AVAssetWriter capture (display or window + system
  audio → H.264/AAC `.mp4`). No BlackHole, no virtual devices, no device switching.
- **darth-tray** — the menu-bar app "Darth Recorder": detects calls, shows a Notion-style
  banner, records, and serves the Meetings PWA over `ws://127.0.0.1:47800`.
- **recorder-poc** — the original CLI, kept for quick capture experiments.

## Darth Recorder (tray) — `./make-app.sh`

Builds, wraps into `dist/Darth Recorder.app`, signs with the Apple Development identity
(`DARTH_SIGN_IDENTITY` to override), installs to `~/Applications`, relaunches. Signed with a
stable Team ID, so the Screen Recording grant survives rebuilds (verified 2026-09-15).
Log: `~/Library/Logs/DarthRecorder/tray.log`. Recordings: `~/Movies/Darth Recorder/`.

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
`recording`, `recording_since/path/label`, `screen_recording_permission`, `version`.
Commands from the page: `{cmd:"start", pid?}`, `{cmd:"stop"}`, `{cmd:"status"}`, and the
test hooks `{cmd:"simulate_call", kind}` / `{cmd:"end_simulated"}`. The PWA side is
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
