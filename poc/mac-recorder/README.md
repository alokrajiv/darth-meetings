# mac-recorder — Darth Recorder (menu-bar helper) + ScreenCaptureKit POC

Native macOS side of Darth Meetings recording (the "Swift tray" angle from Darth Chat
92c0134a). Three targets in one SwiftPM package:

- **RecorderCore** — ScreenCaptureKit → AVAssetWriter capture (display or window + system
  audio → H.264/AAC `.mp4`). No BlackHole, no virtual devices, no device switching.
- **darth-tray** — the menu-bar app "Darth Recorder": detects calls, shows a Notion-style
  banner, records, serves the Meetings PWA over `ws://127.0.0.1:47800`, and updates itself
  from `cli.darth-internal.trames.io` (see *Auto-update*).
- **recorder-poc** — the original CLI, kept for quick capture experiments.

**Open at login is on by default** (0.2.2): every launch registers the `SMAppService` login item unless
the user switched it off in the menu (`loginItemUserChoice` in UserDefaults records an explicit choice;
the default never overrides it). macOS may show "Darth Recorder was added as a login item" once.

**0.2.3 (2026-09-16):**
- **Window-gone hold.** When the recorded window vanishes the tray no longer falls back to a
  display at once. Video stops, system audio + mic keep flowing into the current file, and it
  waits 6 s (`RecordingController.WINDOW_GONE_HOLD`, longer than the detector's 4.5 s end
  confirmation). If the call ends inside that window — Slack closes the huddle window ~4 s
  before it releases the mic — the recording ends normally through the grace/stop path with
  no error banner and no extra part (`main.swift` calls `recorder.noteCallEnded()`). Only a
  call that is still live gets the old fallback (re-picked call window, else the display),
  with the "Recording problem" banner. Events: `window_gone_hold`, `window_gone_held`
  (outcome `call_ended` | `fallback`).
- **Clean stop on quit.** `applicationWillTerminate` finalises an in-flight recording (both
  SCK streams stopped, writer finished, registry row → `local`) before the process exits,
  capped at 5 s; SIGTERM is routed through `NSApp.terminate` so `kill <pid>` and the update
  helper's fallback take the same path. The teardown in `RecordingController.stop` runs on a
  detached task (never the main actor) so the main thread can block on it. A row left at
  `uploading` by a dead process is retried at the next launch. Background: six SCK streams
  leaked by killed 0.1.x trays were found thrashing in replayd before a kernel panic.
- **2560 px cap.** `CaptureSession.pixelSize` caps the longest edge at 2560 px (aspect kept,
  even dimensions); every stream config already sets `scalesToFit`. A 14" display records at
  2560×1654 instead of 3456×2234 (about −40 % bytes on a busy screen; slides stay readable).

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

## What 0.2.0 does (the beta build)

**Call detection** (`CallDetector.swift`): every 1.5 s poll Core Audio's process objects
(`kAudioHardwarePropertyProcessObjectList`) for `kAudioProcessPropertyIsRunningInput` —
i.e. who has the microphone open. Walk the pid up to its Dock-visible app (Teams WebView →
Microsoft Teams, Chrome Helper → Google Chrome), classify by bundle id, and for browsers use
the window title to tell Meet / Teams-web / Zoom-web apart. 2 polls to start, 3 to end. Needs
NO mic permission. System daemons (`/System`, `/usr`) are ignored — `replayd` opens input
while we ourselves record. **A screen share by the same app holds the call open** even after
the mic device closes (`holdOpen`).

**Which window is the call** (`WindowPicker.swift`): title patterns first, the app's
*frontmost* window second, **never largest-by-area** (that is always Teams' Chat/Calendar
window). Teams: skip `Chat |`, `Calendar |`, `Activity |`, `Teams |`, `Calls |`, `OneDrive |`,
`Apps |`, `Copilot |`; prefer a title with "Meeting"/"Call", then a non-nav `… | Microsoft
Teams`. Zoom: `Zoom Meeting`/`Zoom Webinar`. Slack: `Huddle`. Meet: the Meet title. The window
is re-resolved when Record is pressed and every 5 s while recording, and **every candidate
(id, title, frame, z-index, on-screen) is logged** at detection, at record and at each
re-resolve — that log is the field data the beta is for.

**Share detection** (`ShareDetector.swift`, no extra permission): a `/usr/bin/log stream`
subprocess on a narrow predicate over `replayd` + `tccd`, parsed line by line. It runs **only
while a call is live or we are recording** — streaming the unified log costs ~17% of a core,
which a tray must not burn all day — and an orphan left by a force-quit is swept at the next
launch (the predicate carries a `DarthRecorderShareWatch` marker for exactly that). WHO comes from tccd (`AUTHREQ_ATTRIBUTION … accessing={identifier=…}`
whose `requesting=` is `com.apple.replayd`; new Teams shares as
`com.microsoft.teams2.modulehost`), WHAT from SkyLight (`SLContentFilter initWithDisplay:
displayID = 0x…` / `initWithDesktopIndependentWindow: windowID = 0x…`, ids in the clear —
resolved to owner/title through CGWindowList immediately, because window ids die with the
window), START from `Created New Stream … Hash=<id>`, TEARDOWN from
`RPRecordingManager invalidateFilterTimerForStream` (two lines per teardown, collapsed; never
`SLContentStream stop:`, which only fires for picker thumbnails and never when someone leaves
a meeting mid-share). Our own capture is filtered out by bundle id, and our own teardowns are
suppressed explicitly. A 5 s sweep closes shares whose window or app has gone away.

**Recording** (`RecordingController.swift` + `RecorderCore`): one recording = one uuid, one
folder `~/Movies/Darth Recorder/<id>/`, N segments `<base> part<N>.mp4`, three tracks each:

| track | source | how |
|---|---|---|
| video | the CALL WINDOW (`SCContentFilter(desktopIndependentWindow:)`) | its own SCStream, 5 fps |
| audio 1 `mul` | all system audio on the display containing that window | a SECOND SCStream, `capturesAudio`, `excludesCurrentProcessAudio`, 16×16 video nobody reads |
| audio 2 `eng` | the microphone | `AVAudioEngine` input tap → CMSampleBuffer on the host clock |

Never mixed at capture. ffprobe shows `Stream #0:0 Video`, `#0:1(mul) Audio` = system,
`#0:2(eng) Audio` = mic (mp4 drops per-track *names*, so the language tag is the label).
A new segment starts when the call's app starts or stops sharing (video follows the shared
window/display), when the recorded window disappears (falls back to its display), and after an
encoder hiccup. Audio and mic run continuously across segment boundaries. **Every segment
keeps the first segment's pixel size** (`scalesToFit` letterboxes the rest) because the server
stitches multi-file uploads with `ffmpeg -f concat -c copy`, which refuses inputs whose stream
parameters differ. Stop: the call ending shows a 60 s "Call ended — stopping in N s" banner
with **Stop now** / **Keep recording**, then stops by itself.

**Banner** (`Banner.swift`): placed on the display that contains the recorded window (mouse
display as fallback, never `NSScreen.main` — for an accessory app that is an arbitrary
monitor), 6 px accent bar (green call / red recording / amber warning / blue update), slides
in from the top edge, forced `.darkAqua` so labels stay white on the HUD material, and it
stays as a compact pill for as long as the call/recording lasts instead of auto-hiding. Every
warning shown while recording carries a Stop button.

**Sign-in, registry, telemetry, upload** (`Auth.swift`, `Api.swift`, `Registry.swift`,
`EventLog.swift`): sign-in is the darth device flow (`auth.darth-internal.trames.io`,
scopes `meetings=readwrite`) — the menu item and ws `{cmd:"login"}` both start it, the token
lands in `~/Library/Application Support/DarthRecorder/auth.json` mode 0600 next to a
`device.json` holding the device uuid. With a token the tray talks to
`https://meetings.darth-internal.trames.io` (override `DARTH_TRAY_API_URL`):
`POST /api/recorder/heartbeat` on launch and every 5 min, `POST /api/recorder/events` every
60 s and at every stop (batches of ≤500 lines of `events.jsonl`, with a shipped-offset file),
`POST/PATCH /api/recorder/recordings` at start, at every segment and at stop. **Every server
call is fail-soft**: it logs (throttled), sets `needs_sync`, and a 60 s sweep re-upserts —
a recording never waits on the network. Auto-upload (default ON, menu toggle) sends the
segments at stop to the one-shot `POST /api/transcripts?recorderRecordingId=<id>` route
darth-cli uses (raw body, `x-filename`; multi-segment = one `multi_group` stitch group;
`linked_event` from the PWA rides as `x-linked-event`). Local files are kept.

**Logs.** `~/Library/Logs/DarthRecorder/tray.log` is the narrative;
`~/Library/Logs/DarthRecorder/events.jsonl` is the data (one JSON object per line: `ts`,
`kind`, `payload`; rotates at 20 MB, keeps 5) — every detection, candidate list, share event,
banner show/click, user action, segment, upload step, auth step and error, and it is what the
telemetry endpoint ships.

**PWA protocol** (`LocalServer.swift`, Network.framework WebSocket server on loopback).
Every message is a full status snapshot + `type`:
`status | call_started | call_ended | recording_started | recording_stopped | share_started |
share_ended | segment_started | upload_progress | upload_done | upload_failed | auth_changed |
recordings`, with `calls[]`, `recording` (**always a boolean** — the saved file rides under
`saved` on `recording_stopped`; 0.1.5 overwrote the boolean and flipped the PWA chip back to
"Recording"), `recording_since/path/label/id`, `screen_recording_permission`, `signed_in`,
`email`, `device_id`, `share`, `recordings_pending_upload`, `auto_upload`, `version`,
`update_available`, `update_staged`, and `stopping_in` during the grace period.
Commands from the page: `{cmd:"start", pid?}`, `{cmd:"stop"}`, `{cmd:"status"}`,
`{cmd:"login"}`, `{cmd:"logout"}`, `{cmd:"upload", recording_id, linked_event?}`,
`{cmd:"list_recordings", req}` → `{type:"recordings", recordings:[…], req}`,
`{cmd:"set_auto_upload", enabled}`.
Test hooks: `{cmd:"simulate_call", kind, pid?, bundle_id?}` (with a **real pid** it treats that
app as the call, so the window picker, the window filter and the banner run for real),
`{cmd:"end_simulated", pid}`, `{cmd:"simulate_share", kind, window_id?, display_id?,
bundle_id?}`, `{cmd:"end_simulated_share"}`, `{cmd:"check_update"}`. The PWA side is
`src/lib/companion/companion-client.ts` + `src/components/recorder-*`. TODO before this leaves
POC: pairing token + Origin allow-list; today any local page can drive the recorder.

**Verified 2026-09-15 (0.2.0, dev machine):** window recording of a real window with
1 video + 2 audio tracks (`mul` system carries the `afplay` sound, `eng` mic is separate);
segment rolls on share start/end and on the recorded window disappearing; 60 s grace banner
and automatic stop; no "already stopped" error on any stop; sign-in through the device flow;
heartbeat/events/recordings rows on the server; auto-upload of a 1-segment and a 2-segment
recording (stitched) with `transcript_id` coming back; `matched` (calendar match) flowing back
into the local registry. Not yet verified live: a real Teams call and a real Teams screen
share (the share parser is proven on real log lines only for our own captures), the banner on
a second display (the external monitors were disconnected mid-session), and hold-open of a
call while its app keeps sharing.


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

## Gotchas learned building 0.2.0 (keep — each cost a test run)

- **`outputType` in the replayd log is a bitmask of the stream's outputs, not an identity.**
  0 = no output (the share picker's thumbnail streams — dozens per picker open, ignore), 1 =
  screen, 2 = audio, 3 = both. Our own window-only stream logs 1 (exactly like a real Teams
  share) and our audio-only stream logs 2, so **only the client bundle id can identify our own
  capture**. The older "3 = our own recording" note was simply the 0.1.x display+audio stream.
- **AAC settings are validated lazily and kill the whole writer.** `AVEncoderBitRateKey:
  96_000` on the Mac's 24 kHz mono mic is outside the encoder's legal range for that format;
  the first append then fails with `-11861 "Cannot Encode Media / The encoding parameters are
  not supported"`, the AVAssetWriter goes to `.failed`, and every later sample is silently
  dropped → a 0-byte mp4 and an "Empty request body" from the upload route. Do not set a
  bitrate; let the encoder choose.
- **A CMSampleBuffer built with `dataReady: false` must be marked ready.**
  `CMSampleBufferSetDataBufferFromAudioBufferList` does not do it, and appending an unready
  buffer fails the writer the same way.
- **The server stitches multi-file uploads with `ffmpeg -f concat -c copy`**, which refuses
  inputs whose stream parameters differ (`Stitching the recordings failed`, HTTP 502). Every
  segment of one recording must therefore carry the same pixel size and the same track layout.
- **TCC: the dev signature and the Developer ID signature are different grants**, and
  installing a Developer-ID build over the same bundle id takes the Screen Recording grant
  with it — after `./make-app.sh` (dev) the tray can come up with
  `screen_recording_permission: false` and empty window titles until the human toggles it. For
  testing against the real grant, sign a local build with
  `DARTH_SIGN_IDENTITY="Developer ID Application: …" ./make-app.sh --no-run` and run it from
  `/Applications` (no notarization needed for a locally built bundle — Gatekeeper only gates
  quarantined downloads).
- **`log stream --debug --info` triples the cost for nothing**: the lines we need
  (`SLContentFilter`, `outputType`, `Created New Stream`, `invalidateFilterTimerForStream`,
  tccd `AUTHREQ_ATTRIBUTION`) are all DEFAULT level — the `[INFO]` inside the text is
  replayd's own prefix. With the flags the watcher sits at 52% of a core, without them 17%.
  Narrowing with `--process` instead of process clauses in the predicate changes nothing.
- **The `log stream` child outlives a force-quit** unless you terminate it in
  `applicationWillTerminate` and sweep orphans at launch.
- **A window stream dies when its window goes away** (`Failed to find any displays or windows
  to capture`) — that is a segment roll to the window's display, not the end of the recording.
- `NSWindow` constrains a freshly created window to one screen; multi-display test windows have
  to be moved with `setFrameOrigin` *after* they are on screen.

## Not done yet (next steps)

1. Pairing token + Origin allow-list on the local socket (any local page can drive the tray).
2. Teams mute mirroring (needs the Accessibility API), Windows companion (C#/.NET, WGC +
   WASAPI process loopback), deleting local files after upload.
3. Server-side stitching of segments with different geometry (today the tray pins the size).
4. Launch-at-login is a menu toggle (`SMAppService`); no LaunchAgent plist yet.
5. Apple membership renews 14 Apr 2027 with auto-renew off — a lapse breaks notarization.
