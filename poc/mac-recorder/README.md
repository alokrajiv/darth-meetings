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

**0.3.6 (2026-09-18) — hide-able while sharing, resource telemetry, preview source control:**
- **Nothing of ours in a screen share.** The banner, the preview panel, the Record… dialog and the
  menu bar item's own window set `sharingType = .none`: Teams / Meet / Zoom sharing this display (and
  `screencapture`, and any other app's capture) do not include them; the person still sees them.
  Verified with `screencapture` of the banner's region while a test banner was up (pixel-identical to
  the region without it).
- **Banner:** a × on the recording pill hides it (the recording goes on); it fades on its own 10 s
  after a recording starts (menu "Hide the recording banner after 10 s", on by default, `bannerAutoHide`);
  menu "Show banner" / ⌘B brings it back and it then stays. Warnings (a track ✗), the call-ended grace
  card and the saved card still come back on their own.
- **Discreet menu bar icon:** menu toggle (`discreetIcon`) — the plain template glyph whatever the state,
  no red bars, no dot; the menu still shows the recording state and timer.
- **Resource telemetry** (`ResourceSampler.swift`): every 10 s while recording (60 s idle) — own CPU %
  (getrusage delta), memory footprint (task_vm_info phys_footprint), threads, system CPU user/sys/idle,
  system GPU utilisation (IOAccelerator "Device Utilization %"), battery % + state, thermal state, and
  CPU / GPU die temperatures via the SMC (smctemp's per-chip key sets, M1–M5). While recording each sample
  is a `resource_sample` event; `recording_stopped` carries `resources` = avg / max per metric, the
  battery from→to and the worst thermal state. `status` carries the latest sample (`resources`).
- **Preview gear** (`⚙` next to ✕): "Recording: <window>", **Auto — follow the call window**,
  **Re-detect the window now**, and **Record this instead:** every display and window the Record… dialog
  offers (call windows first). A pick rolls a new segment onto it (`source_switch` event with from / to /
  how; `source_mode` auto | manual in `status` and `recording_stopped`). ws: `redetect_source`,
  `set_auto_source`, `set_source {window_id|display_id}`, `set_discreet {enabled}`,
  `set_banner_auto_hide {enabled}`, `show_banner`, `hide_banner`, `resources`, `show_test_banner`.

**Resource profile, measured 2026-09-18 15:54–22:50 SGT (sampler: `top` per 5 s on the tray pid, IOKit GPU
utilisation, `pmset`, SMC die temperatures via `smctemp` from 16:23; CSV in
`~/Library/Logs/DarthRecorder/perf-2026-09-18.csv`, M-series MacBook Pro, Meet window recording then a Teams
window recording with camera off):**

| phase | tray CPU avg / max | tray RSS avg / max | threads | system GPU util | CPU die °C avg / max |
|---|---|---|---|---|---|
| Meet recording, preview OPEN, on battery (3 min) | 8.9 % / 10.1 % | 240 / 241 MB | 26 | 65 % | – |
| Meet recording, preview closed, on battery (15 min) | 5.5 % / 6.5 % | 71 / 77 MB | 12 | 45 % | – |
| Meet recording, preview closed, charging (18 min) | 5.5 % / 6.4 % | 57 / 63 MB | 13 | 58 % | 68 / 75 |
| Teams recording, camera off, charging (58 min) | 9.9 % / 19.1 % | 221 / 249 MB | 25 | 40 % | 67 / 83 |
| idle tray afterwards (5 h) | 1.2 % / 9.8 % | 55 / 65 MB | 7 | 44 % | 64–72 / 101 |

- The **preview panel costs ~4 CPU points, ~165 MB and 13 threads** (the CoreImage thumbnail pipeline + its
  retained buffers, not the level strips). Closing it is the single biggest saving while recording.
- The Teams recording phase shows the preview-open signature (25 threads, 220–250 MB) — either the preview was
  reopened for it, or a Teams window capture retains more than a Meet one; the per-recording resource events
  of 0.3.6 will tell.
- **The tray is not the thermal driver.** The CPU die was *hotter* idle after the recordings (mediaanalysisd,
  Chrome helpers, WindowServer at 26–56 %) than during them; during the Teams recording it sat at 65–68 °C
  and only spiked to 78 °C in the last minute. GPU utilisation is WindowServer + Chrome, the tray's share is
  negligible. Battery on the Meet recording with the preview closed: 70 % → 62 % in 15 min (~32 %/h, most of
  it Chrome + WindowServer + coreaudiod per the top-process column).

**0.3.5 (2026-09-18) — uploads through the resumable session + darth uploads (Azure Blob):**
`Uploader.swift` no longer streams a whole file through `POST /api/transcripts` (nginx + one TCP
stream over the Tailscale relay: the 1.3 GB Meet and 638 MB Teams recordings of 2026-09-18 died with
HTTP 408 on every 30-minute retry). It now uses the same session the web app uses — `POST /api/uploads`
(whole-file sha256 as the fingerprint, `via: "blob"`, `recorderRecordingId`, `multi` for segments) →
bytes → `POST …/complete`. The SERVER picks the byte path: **blob** (the open reply carries a per-blob
SAS on `darthuploads/meetings`; 4 MiB `Put Block`s straight to Azure, `parallel` at a time, `Put Block
List`, then the VM pulls the committed blob once — `docs/darth-uploads.md`) or **chunks** (a host
without the account: `PUT /api/uploads/:id/chunks/:idx`, 4 at a time, sha256 per chunk). Every retry
(a drop, a quit, an update, the 30-min timer) re-opens the SAME session and sends only what Azure / the
server does not hold yet. Backoff 1/2/4/8/15/30 s inside a 30-min window per `upload` call; a 401/403
from Blob re-mints the SAS; `complete` handles 409 not-committed / missing (re-sync), 409 completing
(poll), 503 (the VM's pull hiccuped — again), 404/410 (start over once). Progress is per acknowledged
block (4 MiB) rather than per byte in flight.

**0.3.4 (2026-09-18):** AGC gain now only RISES after 3 consecutive signal buffers (300 ms). 0.3.3 in a
quiet room still reached +24 dB on isolated key clicks before anyone spoke (11 signal buffers, none
sustained). Attack is unchanged (instant, every buffer).

**0.3.3 (2026-09-18, minutes after 0.3.2):** the AGC's speech-level tracker now decays 0.05 dB per
signal buffer (was 0.45): on a normal 1-ch mic in a quiet room 0.3.2 reached +24 dB on keyboard
clicks between sentences, which would have clipped the next word. Gain still converges fast on a
source that is genuinely low (the tracker starts there). Preview snapshot of the 0.3.2 panel
(waveform strips, "−22 dB +24" gain label) in `~/Library/Logs/DarthRecorder/preview-032-onscreen.png`.

**0.3.2 (2026-09-18) — mic level during WhatsApp calls + scrolling level history:**
- **Finding (12:37 SGT WhatsApp call with Kawen, recording 474033cd → transcript 855):** 0.3.1 recorded
  fine (3 ch → mono, 36 s, uploaded) but Alok's mic track peaked at **−42 dBFS** (RMS −55 dB in speech,
  −80 dB floor) against a system track at −29 dB RMS / −2 dB peak; AssemblyAI heard mostly the other
  side and mis-detected Hindi. Cause: WhatsApp puts the built-in mic into its voice-processing (echo
  cancel) mode; Core Audio then hands every other client the RAW 3-capsule feed, ~40 dB below the
  normal processed mono path, and WhatsApp applies its own gain internally. Averaging the three
  capsules (0.3.1) lost a further ~12 dB (peak 0.034 raw vs 0.008 averaged). Speaker vs earphones is
  irrelevant to this — bleed would make the track louder, not quieter.
- **`MicConditioner`** (MicCapture.swift): the mono track is the LOUDEST channel (per-buffer RMS EMA,
  3 dB hysteresis, switches logged) with automatic gain: target peak −12 dBFS, ≤ +36 dB, instant
  attack, 24 dB/s release, gain only rises on buffers ≥ 12 dB above a tracked noise floor, and
  noise-only buffers get −20 dB (downward expander) so the health meter's silence detection still
  works; gain ramps linearly across each buffer (no gate clicks). Runs on every mic buffer (a healthy
  1-ch mic gets gain 1 — the AGC never attenuates). Synthetic test: −55 dB speech on capsule 2 of 3
  → −13 dB out, silence stays < −60, channel 2 picked. Logged: "mic: hardware format … loudest
  channel + AGC", channel switches, `gain=%+.0f dB ch=N/M` in the health line, `mic_conditioner`
  + `mic_hw_format` in `recording_stopped`, summary at `mic: stopped`.
- **Preview panel**: under each level bar a **10-second scrolling envelope** (`LevelHistoryView`):
  `LevelMeter` keeps 500 × 20 ms bins of RMS; drawn as a symmetric waveform (half-height = −60…0 dBFS),
  1 s grid, newest at the right, green / red when ✗. The mic bar's value shows the AGC gain
  ("−18 dB +34"). Alok's ask: "a waveform for the last 10 seconds moving like a graph".
- **Server** (`src/lib/server/multitrack.ts`): `dynaudnorm=f=300:g=15:p=0.9:m=40` per track before
  `amix`, so a quiet mic is brought level with the system track before summing. Offline on the
  12:37 file: mic −65 → −33 dB RMS (peak −10), mix peak −3 dB.

**0.3.1 (2026-09-18) — the WhatsApp "hang" was never SCK:**
- **Root cause of both WhatsApp start failures** (2026-09-16 21:23, 2026-09-17 22:53 SGT): during a
  WhatsApp voice call the built-in mic reports **48 kHz × 3 ch** (every working recording had 1 ch).
  `AVAssetWriterInput` with 3 channels and no `AVChannelLayoutKey` RAISES `NSInvalidArgumentException`
  ("Missing required key AVChannelLayoutKey") inside `Recorder.init` — an Objective-C exception Swift
  cannot catch. It was raised inside a main-queue block (the `Task { @MainActor }` start), AppKit
  swallowed it (thread `SOME_OTHER_THREAD_SWALLOWED_AT_LEAST_ONE_EXCEPTION` at 22:53:41.814 in the
  process sample), and the main DISPATCH queue never drained again: menu, banners and run-loop
  Timers kept working, but every `DispatchQueue.main.async`, URLSession completion and MainActor
  task sat forever. So: no `timed` deadline fired, the audio-only retry never reached the mic
  permission callback, the updater stuck at "check already running", and the 60 s sweeps re-POSTed
  the same registry row and event batch for 12 h (21,095 `recorder_events` rows for 34 events).
  The 0.2.8 `simulate_start_hang` fix addressed a hang that did not exist.
- **Fixes**: `MicCapture` downmixes anything above 2 channels to mono in the tap (`format` is
  now the track's format, `hardwareFormat` the device's; log line "→ mono track");
  `Recorder.init` refuses 0 or > 2 channel tracks with a Swift error; every `Recorder(...)`
  creation runs under `catchingObjC {}` (new `ObjCTry` target: `@try/@catch` → NSError) so a raise
  becomes a normal `recording_failed`; `MainQueueWatchdog` (run-loop Timer, 15 s ping / 45 s
  stall) logs `main_queue_stalled` and relaunches the app via `open` (never mid-recording: warning
  banner, relaunch when the recording ends); `ApiClient` sends one events batch / one sync per
  row at a time (`eventsInFlight`, `syncInFlight` + `syncDirty` re-send) so a dead queue cannot
  become a POST storm; the server's `insertRecorderEvents` skips exact duplicates.
- **WhatsApp profile**: `CallDetector.classify` took the LARGEST window's title ("WhatsApp") so
  `profile(for:)` never saw "voice call" and chose window capture. Now the call card wins in
  `classify`, `WindowPicker.pick` has a `whatsapp: call window` rule, and `profile(for:)` looks at
  every live window of the app; a WhatsApp call whose kind is still unknown is **audio-only**.
- Hooks: `{cmd:"simulate_start_exception"}` (next start raises inside the guarded setup → must end
  as `recording_failed`, app alive), `{cmd:"simulate_main_queue_death", mode:"task"|"block"}`.
  Measured 2026-09-18 11:19 SGT: an NSException escaping a `Task { @MainActor }` job is SWALLOWED
  (no crash report; the main queue stops draining — the exact 2026-09-17 state) and the watchdog
  relaunched the app 56 s later (45 s stall + 15 s tick), new pid bound the ws port and answered
  `status`. The same exception in a plain `DispatchQueue.main.async` block is NOT swallowed: the
  process aborts with a crash report (`darth-tray-2026-09-18-111547.ips`). So the zombie needs
  Swift concurrency on the main actor — which is where every capture start runs.

**0.3.0 (2026-09-16):**
- **Preview panel** (`PreviewPanel.swift`): "Preview" capsule on the recording pill (the pill's
  buttons are now Stop (red) + Preview) and menu "Show/Hide preview" (⌘P while recording). A
  340 px non-activating floating card under the banner, on the banner's display: a live thumbnail
  of the video being recorded — `Recorder.onPreviewFrame` hands the pixel buffer just appended
  to the encoder every 250 ms (`previewInterval`), downscaled off-main with CoreImage — or an
  "audio only" placeholder; two level bars (system, mic; `LevelBar`) fed by the 0.2.6 meters at
  10 Hz: −60…0 dBFS, green fill when audible / grey when quiet / red when the track is ✗,
  peak-hold marker (1.5 s), "silent Ns" label when quiet ≥ 5 s or ✗. Closable (✕, menu, Preview
  again); open/closed remembered in UserDefaults `previewOpen` (reopens on the next recording);
  closes with the recording. Excluded from capture like the banner (display captures exclude
  this app since 0.2.7; window captures only see the call window).
  Hooks: `{cmd:"preview", open}`, `{cmd:"snapshot_preview", onscreen_path}` (on-screen PNG + bar
  values in the answer and tray.log).
- Measured on this Mac during a display recording: tray CPU ≈ 3.7 % with the preview closed,
  ≈ 7.3 % open (10 Hz bars + 4 fps CoreImage downscale). A display-3 recording with the preview
  open on that display contains neither the preview nor the banner.

**0.2.9 (2026-09-16):**
- **Capture profile per call** (`RecordingController.profile(for:)`): `audio` for WhatsApp voice
  calls (title contains "voice call"), Slack huddles and FaceTime audio (no window / "audio" in
  the title); `window` (as before) for Teams, Meet, Zoom, Webex, WhatsApp video calls, browser
  calls and anything unknown. `call_started` and `recording_starting` carry `profile` +
  `profile_reason`.
- **Audio-only recordings**: no SCK video stream and no window pick at all. `Recorder` now has an
  audio-only writer (`init(audioOnlyURL:audioTracks:)`, `.m4a`, same AAC tracks `mul` + `eng`,
  `videoIn` optional). Segments `<base> part<N>.m4a`, `source: {kind:"audio"}`, rolls only on
  writer failure, health line `mic ✓ · system ✓`, banner "Recording WhatsApp call (audio)".
  A share during an audio-only recording is NOT captured (v1): banner "Screen share not captured
  — this call is recorded as audio only" once + event `share_not_captured {share}` every time.
- **Record… dialog** has a "Video" tick-box (default from the profile of the active call; off
  greys the source list); ws `start` accepts `video:false`; `RecordOptions.video` (nil = auto).
- **BUG-2 false alarm fixed**: a video stream that dies and a call that ends inside the 6 s hold
  is the normal end of a call — no `stream_failure`, video stays ✓, no `log_excerpt`. A hold
  that elapses with the call still live (fallback) and a writer failure remain real failures.
- Verified: WhatsApp voice / Slack / Teams-with-`video:false` simulations produced `.m4a` files
  with exactly two audio tracks (60 s of WhatsApp ≈ 550 KB ≈ 33 MB/h); Teams still records the
  window; a simulated share during an audio-only recording gave the banner + event and one file;
  an audio-only upload transcribed on the server (`.m4a` stored with the mix track, audio route
  206); the window-gone-then-call-ended pattern ended with `stream_failure:false` and no excerpt.

**0.2.8 (2026-09-16):**
- **A start can no longer wedge the tray.** 21:23 SGT: SCK never called back for a WhatsApp
  voice-call window; `state` stayed `.starting` forever, every later Record click was ignored,
  SIGTERM hung. Now every awaited start step (shareable content + filter, video stream start,
  system audio stream start) races an 8 s deadline (`VIDEO_START_TIMEOUT`, `timed(_:deadline:)`)
  and logs its duration. A window capture that times out is torn down, event
  `video_start_timeout {step, source, fallback}`, banner "Couldn't capture the call window —
  recording the display instead", and the display containing the window is recorded (the
  window-gone fallback). A display capture that times out fails the recording. The abandoned SCK
  call is disposed of if it ever returns (`orphan`).
- **Cancelling a pending start.** Stop, a second Record click (cancels and starts over) and Quit
  while `.starting` call `cancelStart`: task cancelled, mic stopped, partial streams/file torn
  down, state `.idle`, row `upload_failed` "capture never started (…)", event
  `recording_cancelled`; `applicationWillTerminate` never waits on a pending start.
  Test hook `{cmd:"simulate_start_hang", seconds}` (the next start sleeps inside a timed step).
- **Banner corners.** The rounded card had a square material behind it: a layer mask does not
  clip an NSVisualEffectView's behind-window backdrop. Fixed with `maskImage` (stretchable
  rounded rect, cap insets = radius), `invalidateShadow()` after frame changes, styleMask
  `[.nonactivatingPanel, .borderless]`. The window logs `opaque=false background=clear
  shadow=true maskImage=true` once. `snapshot_banner` now also takes `onscreen_path` — real
  on-screen pixels around the banner via CGWindowListCreateImage (the tray has the Screen
  Recording grant; a shell driving tests does not).

**0.2.7 (2026-09-16):**
- **Our own banner is never recorded.** Display captures (explicit display, display fallback,
  share-of-display) use `SCContentFilter(display:excludingApplications:[this app]
  exceptingWindows:[])`; window mode already captures only the call window; the audio stream
  keeps its own filter (`excludesCurrentProcessAudio`). Verified: the 5 s frame of a 0.2.6
  display recording shows the pill top-centre, the same frame of a 0.2.7 recording does not.
- **Banner restyle.** 16 pt continuous corners on the HUD material, 1 px hairline tinted by the
  accent, SF Symbol in a tinted circle (red recording / amber warning / blue info / green call),
  capsule buttons (`CapsuleButton`: accent-filled primary, translucent secondary), a pulsing red
  dot next to the elapsed time while recording, monospaced digits on the sub line. Placement,
  stoppable rule, auto-hide timings, accent enum and the health tick line are unchanged. Test
  hook `{cmd:"snapshot_banner", path?}` renders the banner to a PNG
  (`~/Library/Logs/DarthRecorder/banner-snapshot.png`) — the way to see it from a shell without a
  Screen Recording grant.

**0.2.6 (2026-09-16):**
- **Live audio/video health.** `LevelMeter` (AudioHealth.swift) on the system track (inside
  `AudioForwarder`) and the mic tap: per-buffer peak + RMS folded into a 5 s window, "audible" =
  window RMS above −60 dBFS, seconds-since-audible and audible-seconds per track. The recording
  banner's sub line is now `03:12 · video ✓ · mic ✓ · system ✓` (also the menu status line).
  ✗ when: system silent ≥ 30 s **while a call is live** (`SYSTEM_SILENT_S`; outside a call quiet
  system audio shows `system ·`, neutral) or the system stream failed/stopped; mic silent
  ≥ 180 s (`MIC_SILENT_S`) or no mic; video no sample for 10 s (`VIDEO_STALL_S`). ws status
  carries `audio: {system:{level_db, audible, silent_s, audible_s, peak_db, buffers, ok,
  stream_alive}, mic:{…}, video:{ok, frames, silent_s, stream_alive}, line}`; broadcast
  `track_health {track, ok}` on transitions.
- **Warn once.** System ✗ → banner "No system audio is being captured — the other side will be
  missing" (warning, Stop button, stays until dismissed; once per recording); when audio comes
  back the recording pill returns. Events on every transition: `audio_silent` /
  `audio_resumed {track, silent_s, level, stream_alive, call}`. Mic/video only tick + event.
- **Diagnostics that used to be tray.log-only now ship as events:** `system_audio_failed
  {error, display_id}` when the SCK audio stream cannot start, `system_audio_stopped {error,
  buffers, level}` on `didStopWithError`; `recording_started` carries `tracks_started`,
  `system_stream`, `system_error`, `mic_stream`, `mic_denied`, `audio_display_id`;
  `recording_stopped` adds `system_buffers/peak_db/audible_s`, `mic_peak_db/audible_s`,
  `video_frames/dup`, `health`, `health_line`, `stream_failure`. When a recording ends with any
  ✗ or a stream failure, `log_excerpt {lines}` ships the last 60 tray.log lines (≤ 8 KB).
- **More logging:** audio stream config (display, rate, channels, excludesCurrentProcessAudio),
  start latency, first system/mic buffer timing + format + peak, a `health:` line every 60 s.
- Background: Atira's 53-min Teams call (recording 58759a71) had a system track silent for the
  whole call; nobody knew until AssemblyAI said "no spoken audio".
- Verified 2026-09-16: with the Mac's output volume at 0, `say` still reached the system track
  at ≈ −14 dBFS — ScreenCaptureKit taps before the output-volume stage, so a muted Mac does NOT
  explain a silent system track.

**0.2.5 (2026-09-16):**
- **Updates land within minutes.** The updater checks every **5 min** (`Updater.defaultInterval`,
  was 6 h; `DARTH_TRAY_UPDATE_INTERVAL` still overrides; first check still 30 s after launch).
  The heartbeat (already every 5 min, `ApiClient.start`) is a second trigger: when the server's
  `POST /api/recorder/heartbeat` answer carries `latest_app_version` newer than the running
  version, `Api.onNewerVersion` starts a check at once (log "api: server says X is out, we are
  Y → checking"), unless one is already running/installing. `latest_app_version` also shows as
  `update_available` in the ws status until the updater has its own answer. Installs still wait
  for the app to be idle. Test hook: `{cmd:"simulate_server_latest", version}`.

**0.2.4 (2026-09-16):**
- **Record… dialog** (menu, ⌘⇧R; replaces "Record this display"). A non-modal floating panel:
  pick a display (name + pixel size; default = the one under the mouse) or a window (windows of
  any detected call's app first, then other on-screen windows grouped by app, capped at 25),
  tick **System audio** / **Microphone** / **Upload to Darth Meetings when it stops** (upload
  defaults to the auto-upload setting and is disabled until signed in). It must never be an
  `NSAlert.runModal`: a nested modal loop entered from a main-queue block (the ws command path)
  never drains the main queue again and wedges every timer — the first cut did exactly that.
  `RecordDialog.swift`; events `record_dialog_opened` / `_start` / `_cancelled`.
- **`RecordingController.RecordOptions`** — `source` (explicit window/display or auto),
  `systemAudio`, `mic`, `upload`. Mic off = the device is never opened and no permission prompt;
  system audio off = no SCK audio stream and no `mul` track; both off = a video-only mp4. The
  track layout is fixed for the whole recording (every segment roll uses the same options); the
  mic is track index 1 after the system track, or 0 when there is none. Options are in the
  `recording_starting` / `recording_started` events and in the ws status while recording.
- **Keep on this Mac.** `upload: false` on the registry row: no automatic upload (launch,
  sign-in, the retry timer), while the menu "Upload N now" and the PWA's Upload still push it.
  The saved banner says "Kept on this Mac, not uploaded".
- **ws `start` fields** `{cmd:"start", pid?, display_id?, window_id?, system_audio?, mic?, upload?}`
  (all optional; absent = automatic). Test hooks: `open_record_dialog` (+ `auto_cancel_s`),
  `retry_failed_uploads`.
- **Failed uploads retry themselves** every 30 min (`UPLOAD_RETRY_INTERVAL`) while signed in
  with auto-upload on: rows at `upload_failed` that still have bytes on disk (never capture-failed
  rows, never keep-local rows), event `upload_retry`. Reason: the server answers 502 whenever
  its transcription hand-off fails (AssemblyAI out of credit on 2026-09-16), and the recording
  must reach Darth Meetings later without anyone clicking.

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

**Flow.** Check 30 s after launch and every 5 min (0.2.5; was 6 h), plus a check as soon as a
heartbeat answer reports a newer `latest_app_version`, plus **Check for Updates…** in the menu
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
