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

**0.3.21 (2026-10-01) — eased capture profile: a hot or busy Mac records at 2 fps instead of fighting the call.**
A colleague's fanless MacBook Air sat at 100 % system GPU and thermal "fair" for whole Teams calls while
the tray captured her 1152×736 pt Teams window at 2x (2304×1472 px), 5 fps BGRA. Under pressure the LIVE
video stream is now eased with `SCStream.updateConfiguration` — never by rolling a part (a part with other
stream parameters costs a full server re-encode at the stitch).

- **Profiles** (`VideoCaptureProfile` in RecorderCore; the policy's levels are `CaptureLoad` in TrayLogic —
  `CaptureProfile` was already taken by the 0.2.9 per-app audio/window profile):

  | | fps | pixel format | cursor | queue depth | bit rate (new parts only) |
  |---|---|---|---|---|---|
  | `normal` | 5 | BGRA | on | 6 | 1.5 Mbps |
  | `eased` | 2 | 420v (`420YpCbCr8BiPlanarVideoRange`) | off | 4 | 1.0 Mbps |

  Queue depth 4, not SCK's minimum 3: the Recorder holds `lastPixelBuffer` for idle duplicates, the
  encoder has frames in flight and the preview holds one while it converts. Both keep the 0.3.20 colour
  pinning (sRGB in, 709 matrix) and the part's pinned size — `updateConfiguration` REPLACES the whole
  configuration, so the switch sends a full one (`RecordingController.videoConfig(size:profile:)`) at
  `pinnedSize`. The writer's adaptor has no source attributes / format hint, so a mid-part BGRA → 420v
  switch is accepted; the encoded track is 4:2:0 either way. One or two idle duplicates right after a
  switch re-append the old BGRA `lastPixelBuffer` — harmless. A writer's bit rate is fixed at creation, so
  1.0 Mbps applies only to a part created while eased (share start, window-gone fallback, writer-error
  roll); nothing rolls for the bit rate.
- **Policy** (`CaptureEasePolicy` in TrayLogic, pure, clock passed in). Step DOWN to eased at once on
  thermal ≥ fair, Low Power Mode, memory pressure ≥ warn, or system GPU ≥ 90 % for 12 CONSECUTIVE real
  samples (2 min at 10 s — counted, not timed; a notification tick never counts, a sample without a GPU
  reading breaks the run). Step UP only after 5 minutes with no trigger AND not a single sample ≥ 90 %
  (the way out is stricter than the way in), and 60 s after the last change. nil / unknown inputs never
  trigger. A `.audioOnly` step on thermal serious / critical exists behind `Config.allowAudioOnly` —
  FALSE in this release (an audio-only part costs a server re-encode); with it off, serious is eased.
  `startingProfile(for:)`: a recording that starts under pressure starts eased (no live change; GPU
  cannot trigger at start). A failed apply reverts the level and holds off new step-downs for 60 s.
- **Carried through every stream.** `currentProfile` (what the recording wants) is used at BOTH stream
  creation sites (`beginCapture`, `rollSegment`) — before this a roll would silently have gone back to
  5 fps BGRA; `streamProfile` is what the live stream really runs. `applyCaptureProfile(reason:)`
  converges the live stream onto `currentProfile` (serialised: an update in flight carries on to the
  newest wish), guarded by recording, no roll in flight, video not stopped, not an audio-only part —
  otherwise the profile is only remembered and the next video stream starts with it (a roll that raced a
  change re-applies when it ends). On a throw: logged, the old profile kept, NEVER a part roll.
- **Wiring.** Every recording `resource_sample` feeds the policy (`ResourceSampler.onRecordingSample`);
  `ProcessInfo.thermalStateDidChangeNotification` and `NSProcessInfoPowerStateDidChange` tick it at once
  (thermal + Low Power read live, memory pressure from the last sample). Reset per recording in
  `start` (with `pinnedSize`). Mode, UserDefaults `captureProfileMode` = `auto` (default) | `eased` |
  `never`: Settings ▸ Capture: Automatic ✓ / Always eased / Never ease (the title says "(eased now)"
  while an automatic ease holds), ws `set_capture_profile_mode {mode}`; applies to the running recording
  at once (`mode_eased` / `mode_never`), `never` = the policy is ignored, `eased` = start eased always.
- **Events / status** (capture pipeline — both telemetry levels). `capture_profile {recording_id, from,
  to, reason, values {thermal, gpu_pct, low_power, mem_pressure}, mode, how: policy|mode|forced|start,
  at_s, applied, deferred?, error?, simulated, fast?, stream {fps, pixel_format, cursor, queue_depth},
  segment}` on every change attempt (`at_start: true` for a recording that starts eased);
  `capture_profile_mode_set {mode, previous, source: menu|ws, recording_id}`; `status.capture_profile =
  {mode}` idle, plus `current`, `stream`, `fps`, `pixel_format`, `eased_seconds`, `changes`,
  `gpu_high_streak`, `inputs`, `simulated`, `fast` while recording; `recording_started` gains
  `capture_profile` + `capture_profile_mode`, `segment_started` gains `capture_profile`;
  `recording_stopped` gains `eased_seconds`, `profile_changes`, `capture_profile_end`,
  `capture_profile_mode`.
- **One banner per recording**, on the first step down the live stream really took (not a menu choice,
  not an audio-only part, not a start already eased): "Easing capture to keep this Mac cool" / "2 fps,
  still recording", info accent, hides after 6 s. On a fanless Air the ease will likely hold for the
  whole call, so nothing else is ever shown about it.
- **Test hooks (ws).** `simulate_capture_pressure {thermal?, gpu_pct?, low_power?, mem_pressure?,
  clear?: true, fast?: true, reset?: true}` overrides the policy's INPUTS field by field (real readings
  fill the rest; kept until `reset` or a relaunch, so a start under pressure can be tested too) and
  ticks it at once; events carry `simulated: true`. `clear` = all clear; `fast` = 2 GPU samples / 20 s
  clear / 5 s dwell. → broadcast `capture_pressure_simulated {outcome}`. `force_capture_profile
  {profile: normal|eased}` drives `applyCaptureProfile` directly (`how: forced`; the policy carries on
  from the forced level) → `capture_profile_forced {outcome}`.
- **Fixed on the way:** `pinnedSize` was never reset between recordings, so a recording that STARTED
  audio-only took the previous recording's pixel size for its first video part (0.3.15's comment says it
  is set there).
- **Tests:** `swift test` 91 (67 + `CaptureEasePolicyTests` 21 + a new `RecorderCoreTests` target with
  `VideoCaptureProfileTests` 3: both profiles' `SCStreamConfiguration` fields, 709 colour kept, the eased
  writer bit rate).
- **Not verified live** (built 2026-10-01 while Alok's Mac was busy with another E2E: `swift build` + unit
  tests only, no dev `make-app.sh`). **How to E2E** on a build that holds the Screen Recording grant
  (ws `ws://127.0.0.1:47800`, a bun `new WebSocket(...)` one-liner as in *Auto-update ▸ Testing*):
  1. `{cmd:"start", upload:false}` (main display) — `recording_started.capture_profile: "normal"`.
  2. `{cmd:"simulate_capture_pressure", thermal:"fair", fast:true}` → at once `capture_profile {from:
     normal, to: eased, reason: thermal_fair, how: policy, applied: true, simulated: true}`, tray.log
     `capture: stream → eased (2 fps 420v, cursor off, queue 4) in N ms`, the banner once;
     `{cmd:"status"}` → `capture_profile.current/stream: eased`.
  3. `{cmd:"simulate_capture_pressure", clear:true}` → ~20–30 s later (20 s clear, next 10 s sample)
     `capture_profile {to: normal, reason: clear}`; no banner.
  4. `{cmd:"simulate_capture_pressure", gpu_pct:100}` → after 2 samples `reason: gpu_sustained`; no
     second banner. `{cmd:"simulate_share", kind:"display"}` while eased → `segment_started
     .capture_profile: eased` (the roll keeps it; a share by "the call's app" needs a call — otherwise
     the share is followed for a display recording anyway).
  5. `{cmd:"force_capture_profile", profile:"normal"}` / `"eased"` → `how: forced`;
     `{cmd:"set_capture_profile_mode", mode:"never"}` → `capture_profile_mode_set` + `reason: mode_never`;
     then `mode:"auto"`.
  6. `{cmd:"stop"}` → `recording_stopped.eased_seconds`, `profile_changes`;
     `{cmd:"simulate_capture_pressure", reset:true}`.
  7. The part that switched (part 1 above) — ONE colour header and 4:2:0 throughout:
     `ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt,color_range,color_space,color_transfer,color_primaries -of default=nw=1 "<part1>.mp4"`
     → `pix_fmt=yuv420p`, `color_range=tv`, `bt709` ×3; and
     `ffprobe -v error -select_streams v:0 -show_entries frame=pts_time,pix_fmt -of csv=p=0 "<part1>.mp4"`
     → every frame `yuv420p`, frame spacing 0.2 s before the switch and 0.5 s after it (the encoded
     stream cannot say which source format a frame came from — the spacing change at the
     `capture_profile.at_s` of step 2 is the evidence that BGRA- and 420v-sourced frames share one part).
     The server stitch (`-c copy`) of a recording whose parts were created under different profiles must
     still succeed: size, codec and colour tags are identical, only the bit rate differs.

**0.3.20 (2026-10-01) — diagnostics while on a call: telemetry levels, who is using the CPU/GPU, per-part capture health, "This feels laggy", unclean-exit reports.**
Recordings lag or lose audio on some Macs and the telemetry could not say whether it was the Mac, the
call app or our capture. And on 29 Sep 15:10 SGT Ivan's 0.3.18 went silent 35 s after a part roll onto a
display share: four `resource_sample`s, then nothing — no `recording_stopped`, no `app_terminating`, a
part-2 file without a moov atom, and no crash evidence from the device.

- **Telemetry levels** (`TelemetryPolicy` in TrayLogic, `Telemetry.swift`): `full` (default) | `partial`,
  UserDefaults `telemetryLevel`. Settings ▸ Telemetry ▸ Full / Partial in the tray menu, ws
  `set_telemetry_level {level}`, `status.telemetry_level`, and EVERY event's payload carries
  `telemetry_level` (`EventLog.log`; the server keeps only `{ts, kind, payload}`). Rich collectors ask
  the policy BEFORE reading anything. A one-time notice (`telemetryNoticeShown`, non-modal NSAlert
  window, `sharingType = .none`) explains it — the ONLY telemetry prompt: nothing pops up when telemetry
  is sent or a lag report goes. Under the menu choice a greyed hint: "Partial keeps machine-level numbers
  only — for personal Macs". Events `telemetry_notice_shown`, `telemetry_level_set {level, previous,
  source: notice|menu|ws}`. Exact split and copy: *Telemetry levels*.
- **Hardware identity** in `app_launched` (flat) and `status.hardware` (→ heartbeat →
  `recorder_devices.last_status`): `hw_model`, `chip`, `ram_gb`, `cpu_cores`, `cpu_perf_cores`,
  `cpu_eff_cores`, `cpu_perf_levels[{name, cores}]`, `gpu_cores` (IOAccelerator `gpu-core-count`).
- **Memory pressure + swap** in every `resource_sample` (`VMStats` in TrayLogic): `mem_free_mb`,
  `mem_active_mb`, `mem_compressed_mb` (HOST_VM_INFO64), `swapins` / `swapouts` as deltas since the
  previous sample, `swap_used_mb` (`vm.swapusage`), `mem_level_pct` (`kern.memorystatus_level`),
  `mem_pressure` normal|warn|critical, `low_power`. `recording_stopped.resources` adds avg/max/min of the
  numeric ones, `swapins_total` / `swapouts_total`, `mem_pressure_worst`, `low_power_seen`.
- **Live calls are sampled, recorded or not.** `resource_sample` every 30 s while a call is live and
  nothing records (`recording: false`, `call_app`, `call_pid`); 10 s while recording (now with
  `recording: true` + the call); 60 s idle, not logged (`SamplerPacing`). Race fixed on the way:
  `ResourceSampler.endRecording()` ran on the stop's detached task while `tick` appended on main — the
  stop now calls it on main before it detaches, and the sampler is main-queue only.
- **`segment_closed`** for every part (roll and stop), from the part's own writer: `video`, `dup`,
  `idle`, `dropped_not_ready` / `dropped_append_failed` (`Recorder.droppedVideo` split), per-track
  `audio_not_ready_system` / `audio_not_ready_mic` (the encoder-busy audio drop was silent before),
  `mix_backpressure` (mix blocks deferred because the mix input was busy — latency, not a hole),
  `system_buffers`, `mic_buffers`, `bytes`, `seconds`, `mix_healthy`, plus the recording-lifetime
  counters cut per part (`SegmentCounters`): `mic_gaps_filled_delta`, `mic_gap_seconds_delta`,
  `coreaudio_overloads`; `reason` = `roll: <why>` | `stop: <why>`.
- **CoreAudio overloads** (`AudioOverload.swift`): an in-process `kAudioDeviceProcessorOverload`
  listener on the mic's device and the input unit's device (Apple's aggregate under voice processing),
  re-attached on every mic restart, on a private queue. Counted per part; `audio_overload {total,
  suppressed_since_last}` at most once per 30 s (`RateLimiter`). Never the unified log.
- **`process_sample` every 60 s while a call or a recording is live — FULL only** (`ProcessSampler.swift`,
  maths in `ProcessTop` with tests): `top_cpu[{name, cpu_pct, pids≤10, pid_count}]` (top 5 apps,
  `proc_listallpids` + `proc_pid_rusage` V4, Mach ticks → ns, helpers grouped by the OUTERMOST `.app` in
  their path), `unreadable` (other users' processes — WindowServer, coreaudiod — answer EPERM, ~343 of
  ~1600 here), `top_gpu[{name, gpu_ms, …}]` from each AGX user client's `IOUserClientCreator` +
  `AppUsage[].accumulatedGPUTime`, and the tagged numbers `self_cpu_pct`, `self_gpu_ms`,
  `watcher_cpu_pct` (our `/usr/bin/log` child — never in `resource_sample.cpu_pct`), `replayd_cpu_pct`,
  `replayd_gpu_ms`, `windowserver_gpu_ms`, `call_app_cpu_pct`, `call_app_gpu_ms`, `collect_ms`.
  Gotcha: `IOServiceGetMatchingServices("AGXDeviceUserClient")` finds NONE (user clients are not
  registered services); they are the IOAccelerator's children in the service plane (142 found, 2 ms).
  Readings on a utility queue; a partial Mac never starts it, and it re-checks the level every tick.
- **"This feels laggy"** (menu, under Show log; ws `report_lag`): `user_lag_report {how, recording,
  recording_id?, call_app?, call_pid?, health_line?, resources}` — plus, on a full Mac,
  `process_sample` (two readings 1 s apart, off main) and `log_excerpt` (tray.log tail) — shipped at once.
  No banner, no dialog: the menu item reads "Lag report sent ✓" for 5 s.
- **Window-pick diagnostics** (Alok: "many times we picked the wrong window / wrong window name"). The
  picker's rules moved UNCHANGED into TrayLogic (`WindowPickRules`, stable rule codes, per-window
  exclusion reasons) with fixtures of the field's bad picks: the Slack huddle recorded as "radhika.rungta
  (DM)" while the huddle was an untitled 1728×1084 window behind it, Teams' "Calendar | Atira Sarat
  (You)" (all-nav-tab windows → `frontmost`), Meet in a background Chrome tab. `window_candidates` (logged
  on EVERY 5 s re-resolve — 5,600 rows for one device in two weeks) is replaced by `window_pick`, emitted
  only at a decision: `detect`, `start`, `reresolve` (only when the picker's answer changed), `roll`
  (share started / ended), `redetect`, `manual`, `fallback`, `simulate`. Plus `window_title_changed` for
  the recorded window (≤ 1 per 10 s, net change). Fields and tier split: *Window-pick diagnostics*.
- **Unclean previous exit** (`RunMarker` in TrayLogic, `UncleanExit.swift`): `running.json` in Application
  Support is written at launch and removed in `applicationWillTerminate` (only our own pid's marker — a
  relaunching copy's survives the old one's quit). Still there at the next launch (and that pid is not a
  live darth-tray) → `unclean_exit {prev_pid, prev_version, prev_started_at, recordings_left_recording,
  last_recording_id?, last_segment?, last_segment_started_at?, last_segment_source?, crash_report}` (the
  recording = the newest row the launch reconcile found still `recording`), `crash_report {file, mtime,
  bytes_total, head}` = the first 12 KB of our newest `darth-tray-*.ips` in ~/Library/Logs/DiagnosticReports
  newer than the dead run's start (names matched before anything is opened — other apps' reports are never
  read), and on a full Mac `log_excerpt {why: "unclean_exit"}` = the last 60 lines (≤ 8 KB) of tray.log
  BEFORE this run's `starting, pid N,` line. Shipped at once. The watchdog's `exit(70)` relaunch also
  reads as unclean (its `watchdog_relaunch` event comes first).
- **Writer defaults** (`Recorder`): H.264 average bit rate 3 → **1.5 Mbps** (`Recorder.defaultVideoBitRate`,
  and an `init(…, videoBitRate:)` parameter for a later profile); colour pinned to **Rec. 709**
  (`AVVideoColorPropertiesKey` primaries / transfer / matrix) with the SCK stream on `colorSpaceName =
  sRGB`, `colorMatrix = 709`; `AVVideoMaxKeyFrameIntervalDurationKey: 4` beside the 2 s frame count.
  BGRA / 5 fps unchanged.
- **Tests:** `swift test` 67 (20 + 47 new: `ProcessTopTests` 12, `VMStatsTests` 4, `SegmentCountersTests` 4,
  `TelemetryPolicyTests` 5, `RunMarkerTests` 8, `WindowPickRulesTests` 11, `TitleChangeTrackerTests` 3).
- **Verified on the dev build (2026-10-01 09:59–10:03 SGT, then the published 0.3.19 put back):** status
  `telemetry_level: full`, `hardware` = Mac15,9 / Apple M3 Max / 128 GB / 16 CPU (12 P + 4 E) / 40 GPU
  cores; the notice showed and its "Keep full telemetry" logged `telemetry_level_set {source: notice}`;
  partial → ws `process_sample` answered `null` and `user_lag_report` carried only `resources`; full → the
  lag report carried `process_sample` + 60 log lines. A simulated Teams call on a real pid: `resource_sample`
  at 30 s spacing with `recording: false`, then `process_sample` at 60.3 s (`collect_ms` 47, 1584 processes,
  343 unreadable, WindowServer 1813.7 GPU-ms/min, `watcher_cpu_pct` 7.0 for the log stream child);
  logging stopped at `call_ended`. SIGTERM → `app_terminating`, no `unclean_exit` after; `kill -SEGV` →
  relaunch logged `unclean_exit` + `crash_report` (`darth-tray-2026-10-01-100257.ips`, 17,815 bytes, the
  12 KB head carries `exception`, `termination`, `faultingThread` and frames) + `log_excerpt` ending on the
  dead run's last line, shipped within 0.2 s of launch. Writer: the same 50 noise frames through
  `Recorder.videoSettings` at 1280×720 — old 3 Mbps 6.13 MB vs new 3.13 MB (−49 %), ffprobe
  `bt709/bt709/bt709` on all three colour fields. Second dev run (10:10–10:11 SGT): a simulated call on a
  real app's pid → `window_pick` `detect` + `simulate` with `candidates_scope: screen`, 30 on-screen windows
  (25 of other apps, `call_app: false`) on full vs `call_app`, the app's 5 windows only, on partial; rule
  `frontmost`, `untitled_call_windows` 5 (window titles are empty for this dev signature — macOS shows
  other apps' titles only with the Screen Recording grant); `report_lag` → event shipped, no banner line in
  tray.log.
- **Not verified live:** `segment_closed`, `audio_overload`, `window_title_changed` and the recording-time
  `window_pick`s (`start`, `reresolve`, `roll`, …) — the dev signature has no Screen Recording grant, and
  `startRecording` refuses without it (audio-only included). Build + unit tests + reasoning only.

**0.3.19 (2026-09-30) — uploaded recordings leave the disk; a Slack huddle is not named after the DM in view.**
- **Local copies go after upload.** 5.3 GB of already-uploaded recordings had piled up under
  `~/Movies/Darth Recorder/` (30 rows, every one `uploaded` and sha256-checked by the server). The tray now
  removes the files of an `uploaded` row one hour after the upload finished (`UPLOAD_LOCAL_COPY_GRACE`;
  `Registry.purgeUploadedLocalCopies`, at launch and on the 30-min retry tick). The row keeps its status
  and transcript id, `bytes` goes to 0 and is synced, `local_purged_at` records it, an event
  `local_copy_purged` is shipped. Rows from before 0.3.19 have no `uploaded_at` — `ended_at` stands in,
  so the backlog clears at the first launch. Never a live, local, failed or "keep on this Mac" row;
  "Delete from this Mac" (0.3.8) is unchanged. A web "Retry" replays the SERVER's copy, never ours.
- **Slack huddles: no window title.** Slack's main window is titled after the DM/channel the person is
  looking at, not the huddle — a huddle Ameya started was born "radhika.rungta (DM)" (recording
  6843e1e4, 13:17 SGT). The tray's link card no longer shows a title for a Slack call, and the server
  names the recording "Slack huddle" (`recorderCallTitle`) for the person to rename. The raw title is
  still recorded in `call.title` as evidence.

**0.3.18 (2026-09-25) — a dead microphone is noticed during the recording, and acted on.**
The 16:02 SGT Teams call (recording a9932a15…): the Microphone menu went to "LG ULTRAFINE" at 16:04 and
to "Microsoft Teams Audio" (a loopback driver) at 16:05 — the mic track then read −120 dB / peak 0.000 for
2684 s while the system track was audible at −10…−13 dB throughout. The only signal was "mic ✗" in a banner
that hid itself after 10 s. 0.3.17 keeps virtual devices out of the picker; 0.3.18 is the other half.

- **Detector** (`Sources/TrayLogic/MicDeadDetector.swift`, pure, `swift test` — 20 unit tests). Fed once
  a second from the health tick with the mic's buffers / loudest sample / loudest buffer RMS since the
  previous tick (`MicCapture.takeTickStats`) and whether the system track was audible. Dead =
  (a) **digital silence**: buffers arriving but none peaked above −100 dBFS for 15 s (a real capsule
  always has a floor); or (b) **silent while the call is audible**: no mic buffer above −60 dBFS RMS for
  60 s, the system track audible ≥ 40 s of that minute, and no mic PEAK above −60 dBFS in it (our own
  extra guard: a quiet listener still has a room, and an automatic switch away from a chosen mic is not a
  cheap false positive). Never while the user muted the mic (0.3.17), never without a mic track (and (b)
  never without a live system track), windows start 5 s after every mic (re)start or unmute, at most one
  detection per 2 min.
- **Action** (`AppDelegate.micDead`): a red banner that does NOT hide itself ("Microphone is silent …",
  the device, what was done, the health line). A manual pick (`micDeviceUID`) falls back to Automatic
  (the pref is cleared — the same path as "Automatic — follow the system default"); Automatic is
  re-detected once and checked again 30 s later — still dead by (a), or nothing from the mic for 20 s while
  the system stayed audible for ⅔ of it → "Microphone is still silent — pick one in the tray menu". After
  that follow-up the detector holds off until the mic recovers or 10 min pass. The restart's own
  "Microphone changed" notice is suppressed so it cannot replace the red banner. Health line reads
  `mic ✗ DEAD` (menu status line + banner) while the condition holds.
- **Telemetry / ws.** Events `mic_dead_detected {reason, device, device_label, mode, silent_s,
  system_audible_s, follow_up, simulated, at_s}`, `mic_dead_fallback {from, to, outcome}`,
  `mic_dead_redetect`; broadcast `mic_dead`; `status.audio.mic_dead {active, reason, silent_s,
  system_audible_s, detections, follow_up_pending, last_action, simulated, last{…}}`.
- **Test hook** `{cmd:"simulate_mic_dead", mode:"zero"|"quiet"|"low"|null}` (recording with a mic only):
  the capture hands zeros / −110 dBFS noise / −80 dBFS noise to the meter AND the file, without the
  user-facing mute; null = the real microphone again.
- **E2E (ws, audio-only, no upload, all three recordings deleted):** MacBook mic pinned → zero → detected
  `digital_silence` 15 s after the last mic restart, pick fell back to Automatic (AirPods), `mode: auto`;
  zero kept on → second detection in Automatic exactly 120.0 s later → re-detect → follow-up "still
  silent" 31 s later. Mic muted + zero for 25 s → nothing; unmuted → detected after 21 s. "low" −80 dBFS for
  75 s with a silent system track → nothing; "quiet" −110 dBFS → `digital_silence` after 16.4 s. Branch (b)
  is unit-tested only (making the system track audible would have meant playing sound on the owner's Mac).
  Seen on the way: pinning the MacBook mic while AirPods are the default makes the raw engine stop on
  configuration changes five times in ~12 s (0.3.16 behaviour, gap-filled) — the first detection came
  25 s after the simulate because each restart restarts the window.

**0.3.17 (2026-09-25) — either audio track can be switched off mid-recording; virtual inputs are never the mic.**
Alok: the tray could switch the video source to audio-only but had no way to turn the system audio or
the microphone off. Same day, 16:05 SGT: a 48-minute Teams call recorded digital silence on the whole mic
track (−120 dB for 2684 s) because the mic had been hand-picked as "Microsoft Teams Audio" (Teams'
loopback driver), and the pick persisted.

- **Audio submenu** (`AudioMenu.swift`; tray, and the preview gear next to Microphone). While recording,
  un-ticking a track MUTES it: `MicCapture.muted` / `AudioForwarder.muted` zero the buffers in place, so
  the timeline and the live mix track stay intact, no part roll, and ticking it again resumes. Health
  reads `mic off` / `system off` instead of a silence fault. A track the recording started without is
  greyed (the writer's tracks are fixed). Idle, the ticks set what the NEXT recording starts with (banner
  Record, menu Record, the Record… dialog's check boxes follow them) and reset to both-on once it starts;
  not persisted. ws `set_audio_tracks {system?, mic?}`; `status.audio_tracks {recording, system{on,
  in_recording}, mic{…}, summary}`; events `audio_mute_change`, `next_audio_change`, `next_audio_reset`.
- **Virtual devices are not microphones.** `AudioDevices.Device.virtual` from
  `kAudioDevicePropertyTransportType` (virtual or aggregate: Teams Audio, BlackHole, the VPIO/default
  aggregates). The Microphone menus list them greyed "— virtual, no microphone"; `pickMic` refuses one
  (menus and ws `set_mic_device`) with a banner; a persisted virtual pick is cleared at launch; status
  `mic_device.devices[]` carries `virtual`.
- **E2E (ws, audio-only, no upload, recordings deleted):** a muted track is exactly −inf dB. Mic muted
  for 8 s → the `eng` track −inf for file t = 7.0–14.5 s, −35…−104 dB room floor on both sides (AirPods
  mic, no playback). System muted → `mul` −inf over the muted window vs −28.0 / −31.2 dB `say` speech
  before and after. Gotcha for the driver: file t = 0 is ~2 s after the `start` command, so fixed windows
  keyed to send times straddle the edges — measure per 0.5 s.

**0.3.16 (2026-09-23) — the microphone follows device changes, heals itself, and can be picked.**
Meet "Salesforce x Trames — follow up", 11:03 SGT: the AirPods left the recording twenty seconds in
and the mic track stayed empty for the remaining 33 minutes — 212 buffers, `mic ✗` on the health line
from 11:07, the MacBook's own mic never asked. Alok: *"when audio device changes and shit — it doesn't
detect … the gear icon also doesn't allow auto redetect … nor does it allow manual picking"*.
`AVAudioEngine` follows the system default input only until the device it started on goes away;
then it stops, and nothing in 0.3.15 noticed or started it again.

- **Self-healing capture** (`MicCapture`, `AudioDevices.swift`). Three triggers restart the mic on a
  fresh engine, counters and the writer's track untouched: the engine stopping on a configuration
  change (`AVAudioEngineConfigurationChange`, only when it really stopped — the voice-processing unit
  posts one ~100 ms after every start with the engine still running); CoreAudio saying the default
  input or the device list changed and the device we want is no longer the one we are on; and a
  1 s watchdog — no buffer for 3 s, or the engine not running (the 11:04 case had no usable
  notification). Restarts are teardown, a 1 s gap, then start (back-to-back, the new engine comes up
  dead or stops once more — self-test), never closer than 2 s, each logged as `mic_restarted` with
  from/to device; a device change also shows a "Microphone changed" banner.
- **The file format no longer depends on the device.** The mic track is 48 kHz mono whatever the
  microphone (`MicCapture.canonicalRate`, `AVAudioConverter` in the tap when the device runs at another
  rate — AirPods in their voice mode are 24 kHz), so a swap mid-part cannot hand the AAC input a rate
  it was not built for.
- **Outages are filled, not dropped.** AVAssetWriter packs audio samples back to back, so a restart's
  silent seconds would simply vanish from the mic track and everything after them would sit early
  against the system track (first E2E: 21.5 s of mic in a 34 s recording). The tap now writes silence
  for any gap over 250 ms before the first buffer of the new engine (`fillGap`, ≤ 1 s pieces, logged;
  `gaps_filled` / `gap_filled_s` in the device block). Second E2E: mic track 34.03 s of 34.07, and the
  mix and mic tracks' per-second levels line up throughout. What a switch costs in mic audio: ~3.5–4 s
  for a default-input change in automatic mode (CoreAudio settle 1 s + the 1 s gap + the voice-processing
  unit's own stop), ~1.2 s for a pick or a re-detect.
- **Microphone menu, both surfaces** (`MicMenu`): the preview's gear has a "Microphone" submenu under
  the video sources, and the tray has its own "Microphone" item — live idle (the pick is the next
  recording's device) or recording (the capture restarts on the pick at once). Entries: what is
  captured right now, "Automatic — follow the system default (…)", every input device, and
  "Re-detect the microphone now" while recording. Pref `micDeviceUID` (nil = automatic); ws
  `set_mic_device {uid|null}` / `redetect_mic`, and `mic_device {mode, uid, current, restarts,
  devices[]}` in `status`; `audio.mic.device` in the health block; `mic_device` on the started /
  stopped events.
- **A chosen microphone runs raw.** Apple's voice-processing unit takes its input from the system
  default whatever `kAudioOutputUnitProperty_CurrentDevice` says (probed on Global/0, Global/1,
  Input/1 and Output/0 — the hardware format never left the MacBook mic), so a pin is honoured on the
  plain AUHAL path with echo cancellation off, and the menu says so. Automatic mode keeps voice
  processing. A pinned device that is absent falls back to the default and is picked up when it returns.
- **Two deadlocks found by the self-test, neither shipped.** (1) `AVAudioEngineConfigurationChange`
  observed with `queue: .main` — NotificationCenter then waits for main, while main may be releasing
  that engine (`dealloc` does a `dispatch_sync` onto the engine's queue, which is the one posting):
  observed with `queue: nil` and hopped to main by hand, and old engines are released off the main
  thread. (2) CoreAudio listener blocks on the main queue — `AudioObjectRemovePropertyListenerBlock`
  from main waits on an in-flight delivery to main: the listener lives on a private queue.
- **Self-test:** `DARTH_TRAY_MIC_SELFTEST=1` (voice processing) / `=raw` on the signed `.app` binary —
  start, flip the SYSTEM default input to BlackHole and back, pin and release, kill the engine behind
  the capture's back; PASS/FAIL table, exit 0/1, the default input restored. Both modes 8/8 on
  2026-09-23. (The MacBook mic's format under voice processing reads 9–10 ch and BlackHole's 2–10,
  run to run — the device is proven by the format only on the raw path.)

**0.3.15 (2026-09-22) — an audio-only recording can be given a video source, from either menu.**
Alok, on a Slack huddle where somebody was sharing a screen, 18:33 SGT: the preview's gear said
*"Audio-only recording (no video source)"* and offered nothing — *"why can't I update source?
what's the point else"*. A Slack huddle is `.audioOnly` by profile (`RecordingController.profile(for:)`),
and until now that was the end of the story for the rest of the recording.

- **The per-app profile is only the DEFAULT.** The gear menu now shows the same source list on an
  audio-only recording, headed **"Add video — record this:"** (displays, then the call's windows,
  then everything else), plus an **"Audio only"** entry at the bottom with a tick on the current
  state. Picking a display or window calls `switchSource`, which rolls a new part **with** video on
  exactly the path a share flip uses — the audio tracks carry straight on (mix + system + mic), the
  part is `<base> part<N>.mp4` next to the `.m4a`. Picking "Audio only" on a video recording rolls
  the other way. The person's pick owns the source for the rest of the recording (`sourceMode = "manual"`).
- **Reachable without the preview panel.** The tray menu has a **Video source** submenu with the
  same items (`SourceMenu` builds both), greyed as *"Video source — not recording"* when there is
  nothing to change. It is built when it opens, so the window list is never older than the click.
- **The head line is never a dead end**: *"Audio only — add a video source below"* / *"Recording:
  <source>"*, and the gear's tooltip says the same.
- **Privacy.** A pick is the only thing that ever gives a recording a video source; nothing here
  auto-captures a screen (a Slack share is not even visible to the share detector). And because such
  a recording only has video by request, when that window goes away it falls back to **audio**, never
  to a display nobody chose — both in the window-gone hold (`holdElapsed`) and when a share ends.
- **Two things the E2E caught** (2026-09-22, four parts audio→window→audio→window against a
  throwaway TextEdit window): `segmentURL` read the extension off `currentSource`, which
  `rollSegment` has not moved yet — so every part after a switch was named for the part before
  it (a window part called `.m4a`). It now takes the source it is being built for. And a
  recording that starts audio-only has no `pinnedSize`, so a second video part would have been
  encoded at whatever size that source happened to be; the first video part pins it
  (`part2` and `part4` both probed 1312×844).
- **Mixed parts and the server.** One recording can now hold an `.m4a` part and an `.mp4` part. The
  files are right and each part's facts are right (`tracks: {count, mixFirst}` is per-recording and
  unchanged across parts; `contentType` follows each file's extension). The server stitches such a
  group since meetings `fa9f692` (2026-09-22, deployed the same evening): `concatMediaReencodeToTemp`
  synthesises black video sized like the video parts over every audio-only span, keeps every audio
  track in order (track 0 stays the live mix) and writes `.mp4`. Before that commit the re-encode
  branch decided `allVideo` from every input and silently wrote an audio-only `.m4a`. The tray keeps
  `upload_mixed_parts` in the event log and `mixed_parts` on the registry row as the record of which
  recordings were mixed; the "video stays on this Mac" banner that 0.3.15 briefly carried is gone.

**0.3.13 (2026-09-22) — linking a recording to a meeting is the USER's action.** The server's
matcher (`recorder-match.ts`) scores every recording against the calendar occurrences it overlaps,
and `POST /api/uploads` used to turn a confident match into a LINK all by itself. On 2026-09-22 a
private Slack DM huddle (15:48, `call.kind = "slack"`) was born as the Google Meet event "Triton
next steps!" (15:30–16:30) on time overlap alone — title score 0 — and the link auto-shared it with
the event's 8 invitees the moment the placeholder existed. Nobody but the owner had opened it;
the repair was by hand. The rule now (`docs/recorder-link-confirm-spec.md`): **the match is a
suggestion, the link is an answer.**

- **The card.** When a recording ends and the registry row carries a `matched` event with a key and
  a title, the upload card becomes a question: *Link to "Triton next steps!" (15:30)?* with the
  call's own app, clock time and window title underneath — *This recording: Slack · 15:48 ·
  "Swaralee (DM) - Trames Pte Ltd …"* — so a Slack huddle offered a Meet event is obvious at a
  glance. Buttons: **Link** / **Not this**. There is no × on it.
- **Link** uploads with `linkedEvent: { key: <matched.event_key> }` on part 1 — the same explicit
  link the web stepper sends, resolved server-side into title, date, attendees and invitee shares,
  because a human said yes. **Not this** uploads UNLINKED and stamps the row `link_prompt:
  "not_this"`; when the upload comes back with a transcript id the tray opens
  `…/transcript/<id>?link=1`, the page's own "link the calendar event" picker. **No answer** —
  card replaced, ignored, app quit — is unlinked, never linked: a 60 s deadline (`LINK_ASK_LIFE`)
  resolves it and starts the upload. The bytes never wait longer than that, and the answer starts
  nothing if the recording has meanwhile been sent by the menu, the PWA or a launch drain.
- **Timing.** The link can only be declared on part 1, so the question must be asked before the
  first byte. A row that has no `matched` yet waits `LINK_MATCH_GRACE` (2 s) for the stop PATCH's
  answer — the server re-matches on every write — and then either asks or goes up unlinked exactly
  as before. A recording with no match behaves as it always did.
- **Test hook.** `{cmd:"simulate_link_card", recording_id?, event_title?, event_start?, life?,
  real?, auto?}` over the ws port. Without `real` it only DRAWS the card (no upload, no registry
  write) and answers `{type:"link_card_answer", answer}`; with `real: true` it runs the genuine
  `askLink` for that row. `auto: "link" | "not_this"` presses that button 1.5 s later, so the whole
  chain is testable without a call. Verified 2026-09-22 against a tray pointed at a fake API
  (`DARTH_TRAY_API_URL`): Link → body carries `linkedEvent {key}`, Not this → no `linkedEvent` and
  `link_prompt` on the row, no answer → unlinked upload at +61 s, already-uploaded row → nothing.
- **Slack huddles and screen shares (D6).** The share watcher never saw the 15:48 huddle share
  anything, and the unified log says why: in that whole window `replayd` created exactly ONE
  ScreenCaptureKit stream — ours (`accessing=io.trames.darth.recorder`, `outputType=2`, audio only,
  15:48:52 → 15:56:54). `com.tinyspeck.slackmacgap` appears in `tccd` only as the subject of its own
  `kTCCServiceScreenCapture` PREFLIGHT queries at 15:48:42/44 (Slack asking whether it may share,
  as it does whenever a huddle starts), never as `accessing=` on a request `com.apple.replayd` made
  — and over 2026-09-20…22 no Slack line in `tccd`/`replayd` mentions replayd at all. So there is
  nothing to add to the watcher (which has no per-app list anyway: it reports whatever bundle tccd
  attributes, and only our own is suppressed). Note also that a Slack call is recorded AUDIO ONLY
  by design (`RecordingController.profile(for:)`: `.slack → .audioOnly`), so such a recording has
  no video whatever anyone shares. Whether a real huddle share would show up in the log is still
  unproven — no app on this Mac used SCK in those two days: start a huddle, share a window, and
  grep the watcher's own predicate for `Created New Stream` + the attribution line to settle it.

**0.3.12 (2026-09-22) — the tray makes the mix itself, as the first audio track.** A Darth
Recorder file has always carried its sources unmixed — system audio as track 0, the microphone
as track 1 — and the server mixed them at ingest (`src/lib/server/multitrack.ts`). That mix-down
is the reason a recorder upload may not hand its bytes straight to AssemblyAI: whoever reads ONE
audio track out of a multi-track file hears one side of the call, which on 2026-09-16 was a Slack
huddle transcribed at 484 words instead of 1429. So every tray upload was pulled down to the VM,
mixed, and pushed on — and the tray is the biggest user of the blob transit that exists precisely
to keep bytes off the VM (`docs/recordings-blob-spec.md`, DEC-1).

- **`LiveMix` (`Sources/RecorderCore/LiveMix.swift`).** Each source hands its buffers to the mixer
  on its own thread; they are folded to mono, resampled to 48 kHz by linear interpolation and
  summed into an accumulator indexed by TIME — the frame index comes from the buffer's
  presentation timestamp, not from a running count, so the two sources line up exactly as they do
  in the file (both timestamp against the host clock) and neither drift nor a late-starting
  microphone can smear the mix. Whatever is more than 1 s behind the newest sample goes out in
  100 ms blocks through a peak limiter (instant attack, ~+0.4 dB per block release, ceiling 0.95).
  No per-track normalisation, unlike the server's dynaudnorm pair: the mic arrives conditioned
  already (`MicConditioner`, and Apple's AGC when voice processing is on).
- **Track order.** `Recorder` adds the mix input BEFORE the raw ones whenever there is more than
  one source, so the file is video, mix, system, mic. The raw tracks are untouched — the point was
  never to lose them. `appendAudio(_:track:)` still takes a SOURCE index; nothing upstream knows.
- **`qmx`.** The mix track is labelled with the ISO 639-2 language `qmx`. `qaa`–`qtz` is the range
  reserved for local use, so it cannot collide with a real language, and the language code is the
  ONLY per-track label `AVAssetWriter` writes that survives into the file — `quickTimeUserDataTrackName`
  and `commonIdentifierTitle` were both tried and ffprobe shows neither (2026-09-22). The server's
  `isMixTrack` reads it, which is what stops the VM mixing a mix back in with the raw tracks.
- **`tracks: {count, mixFirst}` on every upload open.** `mixFirst` is the promise that audio track
  0 is the WHOLE recording (the live mix, or the only source when there is one), and it is what
  lets the server hand the bytes to AssemblyAI where they lie. It is read per recording from the
  registry row (`mix_first`, written by the recording controller from the writer it really built),
  never from the tray's version: recordings made by an older tray are still on this Mac and their
  files still start with the raw system track. The verdict is deliberately strict — a false yes
  is the 484-word incident, a false no costs only the fast path — so a mix that hit an unexpected
  sample format, had a buffer arrive more than a second late, or does not cover the whole
  timeline its sources wrote records `mix_first: false`, and that recording uploads the old way.
  `recording_started` gains `mix_track`, and the segment-closed log line carries the mixer's
  counters (`mix frames=… buffers=… src0=… src1=… healthy=…`).
- **Proof without a capture.** `recorder-poc --selftest-mix <out.m4a>` feeds two synthetic tones
  (440 Hz "system" at 48 kHz stereo, 880 Hz "mic" at 24 kHz mono starting 0.5 s late) straight
  into `Recorder.appendAudio` — no microphone, no screen, no permission — and writes the file.
  Verified 2026-09-22: `qmx` stereo first, then `mul` stereo and `eng` mono; before 0.5 s the mix
  carries the 440 Hz tone alone at amplitude 0.30, after it both at 0.30 each (peak 0.54, nothing
  limited), and neither raw track has a trace of the other's tone.

**0.3.11 (2026-09-22) — the same recording is never transcribed twice.** A retry after a
half-failed upload, a second tray on the same Mac, a recording the user had already sent by
hand: until now every one of those started a fresh AssemblyAI job for bytes the server already
had (prod holds 18 (filename, owner) groups uploaded 2–4 times, and one podcast that was billed
9,649 s for 4,182 s of audio). Server side is `docs/recordings-same-file-spec.md`
(`MW_SAME_FILE_CHECK`); the tray's half:

- **Every segment is hashed ONCE, before the first byte.** `upload(recordingId:)` streams a
  CryptoKit SHA-256 over each file up front instead of `putOne` hashing its own file — the same
  work, just early enough to be useful — and logs
  `upload: <id> — hashed N file(s), B B in T ms`.
- **`dupAware: true` on every open.** That flag is what version-gates the whole feature: a
  server with the check on answers `{duplicate}` only to a client that says it understands the
  answer, so an older tray keeps today's behaviour byte for byte.
- **`multi.partSha256` on part 1** of a multi-segment recording: every segment's hash, in order.
  The recording's identity is `sha256(part hashes joined by "\n")`, so a 6-segment 696 MB
  recording is recognised before segment 1 moves — not after all six are on the VM.
- **A duplicate is not an error.** The open answers HTTP 200 `{duplicate:{meetingId,…}}` with
  nothing created; the tray stops (no further segments), writes `status: uploaded` +
  `transcript_id` to the registry and shows the normal "Uploaded · Open transcript" card and
  menu line. No prompt — the bytes really are up there. `upload_duplicate` in `events.jsonl`
  records it. A group whose parts were not declared is recognised at the last segment's
  `complete` instead, still before the AssemblyAI hand-off.

**0.3.10 (2026-09-21) — the far end is not in the mic track any more.** On speakers the
microphone also hears the other people, tens of milliseconds after the system-audio track does.
The server's mix (`src/lib/server/multitrack.ts`: amix of the system track and the mic track,
each through its own dynaudnorm) then carries them TWICE — a comb-filtered double of every
sentence — and diarization smears across the two copies. `MicCapture` opened the mic as a raw
`AVAudioEngine.inputNode` tap with no echo cancellation at all.

- **Apple's voice processing on the input node.** `inputNode.setVoiceProcessingEnabled(true)`
  (the VPIO unit): acoustic echo cancellation with the system's own output as the reference,
  noise suppression, and Apple's AGC. On by default. Four things it forces, each with its own
  log line:
  - **Order.** It must be switched on BEFORE the tap is installed and before the engine starts —
    enabling it rebuilds the IO unit — and the node's format changes with it (mono, usually a
    different sample rate). So the tap format, `MicCapture.format` and the writer's mic track
    spec all come from `inputNode.outputFormat(forBus: 0)` re-read AFTER enabling, never from
    the hardware format we looked at first (`mic: voice-processing formats — input … output …`).
    The raw path still reads `inputFormat(forBus: 0)` and still folds > 2 channels to mono the
    0.3.1 way, so a WhatsApp 48 kHz × 3 ch feed is handled exactly as before when VPIO is off.
  - **Ducking.** macOS 14 makes VPIO duck every OTHER app's audio — which would duck the call
    we are recording. `voiceProcessingOtherAudioDuckingConfiguration` is set to
    `(enableAdvancedDucking: false, duckingLevel: .min)`. (No `#available` guard: the package's
    deployment target is macOS 14, so the API is unconditionally present.)
  - **Two AGCs do not stack.** `isVoiceProcessingAGCEnabled` stays true — Apple's AGC owns the
    level — and `MicConditioner`'s own gain is capped at **+12 dB** while VPIO runs (+36 dB on
    the raw path, `MicConditioner.setMaxGainDb`, which `reset(channels:)` does not clobber). The
    conditioner's loudest-channel pick and its expander stay as the fallback for when VPIO is
    off. `isVoiceProcessingBypassed` is held false.
  - **Fallback.** If enabling throws, or the engine refuses to start with it on, the engine is
    thrown away and started once more raw — `mic: voice processing unavailable — raw input` —
    and the capture records `unavailable` (not `false`), so the event log distinguishes "the
    user turned it off" from "this Mac refused".
- **Preference + menu.** `UserDefaults` key `micVoiceProcessing`, default ON. Menu item
  **"Cancel speaker echo in the mic (voice processing)"** with a check mark, next to the
  discreet-icon and banner-auto-hide toggles. It is read ONCE, when a recording's microphone
  starts (changing it mid-recording would mean tearing the input engine down and rolling a
  segment), so it takes effect on the next recording — the item's tooltip says so.
- **Telemetry.** `recording_started` and `recording_stopped` gain `mic_processing`
  (`true | false | "unavailable"`), `mic_processing_requested`, `mic_format` (the input format
  the mic track was actually built from) and `mic_hw_format`. `audio_health` is unchanged. Also
  fixed while in there: `recording_stopped`'s `mic_conditioner` and `mic_hw_format` had been
  `null` since 0.3.2 — they were read off `self.mic` inside the detached finish task, one line
  after `mic = nil`; the facts are now captured before the object is released.
- **ws contract** (older trays simply do not answer the new commands):
  - `set_mic_processing {enabled: Bool}` — sets the preference; a `status` broadcast follows.
  - every status payload gains `mic_processing: {enabled: Bool, active: Bool|null}` —
    `enabled` is the preference, `active` is what the last recording's microphone really ran
    with (`null` until a recording has had one, `false` when VPIO was asked for and refused).
  - `mic_echo_probe {seconds?: 10, processing?: Bool}` → `mic_echo_probe_result`. Refused with
    `{error: "busy", reason}` while a call is detected or a recording is live (the burst would
    be heard by the people on the call) and while another probe runs.

**The echo probe** (`Sources/darth-tray/EchoProbe.swift`) — how much of the speakers is in the
mic, as a number, without anyone having to listen to anything. One pass plays a deterministic
wideband noise burst (fixed-seed LCG, 200 Hz – 7.5 kHz, peak ≈ −16 dBFS, 50 ms fades; noise and
not a repeated chirp because its autocorrelation is a single spike, so no second peak can be
mistaken for the echo) out of the default output, while capturing the system-audio track and the
microphone. Both tracks are resampled to 16 kHz on a common host-clock time base (SCK audio and
the mic tap both timestamp against `CMClockGetHostTimeClock`, which is what makes a lag in
milliseconds mean anything), and the mic window is slid over the system track across **±300 ms**
for the largest normalised cross-correlation (`vDSP_conv` + a running energy for the per-lag
normalisation).

With no `processing` argument it runs **twice — VPIO on, then off** — so the reply shows the AEC
effect as two numbers from the same room a second apart; pass `processing: true|false` to run a
single pass.

```
{ "type": "mic_echo_probe_result",
  "seconds": 10, "processing": true,            // the headline fields are the FIRST pass
  "peak": 0.071, "lag_ms": 38.4,                // 0…1 and ms
  "mic_rms_db": -31.2, "system_rms_db": -17.9,
  "peak_with_processing": 0.071, "peak_without_processing": 0.642,
  "peak_drop": 0.571, "peak_drop_db": 19.1,
  "output_device": "MacBook Pro Speakers", "input_device": "MacBook Pro Microphone",
  "analysis_rate": 16000, "lag_search_ms": 300,
  "passes": [ { "processing": true,  "peak": …, "lag_ms": …, "mic_processing": true,
                "mic_format": "24000 Hz × 1 ch", "mic_agc_db": …, "window_s": 4.0, … },
              { "processing": false, "peak": …, … } ] }
```

**How to read it.** `peak` is the fraction of the mic window explained by a delayed copy of the
system track. Speakers with no echo cancellation is typically **0.3–0.9** with `lag_ms` a small
positive number (air + the output device's buffering). With AEC the peak should fall a long way
— same burst, same room, residual only — so a healthy `peak_drop_db` is the whole result.
`lag_ms` is only meaningful when the peak is. A peak near **0 in BOTH passes** means there was no
acoustic path at all (headphones, output muted, the burst never played) and the probe proves
nothing: look at `output_device` first.

**It never stores audio.** Deliberately not "a recording that is deleted afterwards": there is no
file, no registry row, no upload and no temp directory — the two tracks live in memory as Float32
for the length of the probe and die with the object. The one other difference from a real capture
is that the probe's SCK stream sets `excludesCurrentProcessAudio = false` (a recording excludes
our own audio; here our own burst IS the reference signal and has to be in the track).

**0.3.9 (2026-09-21) — the tray says where the bytes are** (design: `docs/recorder-upload-ux.md`
§0–3). Until now a 696 MB / 6-part upload showed a 12-second "Uploading to Darth Meetings…" card
and then nothing at all, while the web read part 1's size as the whole recording's.

- **Progress is about the RECORDING, never a session** (P2). `Uploader.onProgress` hands over an
  `UploadProgress {id, segment, segmentsTotal, bytesSent, bytesTotal, pct}` — bytes of the whole
  multi-part recording — throttled to **one callback per 500 ms per recording** (the first tick and
  the tick that finishes a file always pass). The open body now carries `multi.groupBytes` (the sum
  of every part's size), so the server's placeholder row is born knowing the real total.
- **Menu line** under the status line (`uploadLine`, hidden when there is nothing to say):
  `Uploading “Alok <> Paola – Post SG…” · 43% · 298 MB of 696 MB · part 3 of 6` while bytes move
  (updated by `refreshUploadLine()` alone, never a full `refreshMenu()` twice a second) →
  `Uploaded “…” — transcribing · Open transcript` (opens `PWA_URL/transcript/<id>`, kept 10 min or
  until the next upload) → `Upload failed “…” — Retry now` (kept 35 min, re-runs the upload).
  Title = `matched.title` → the call's window title → the started-at date, clipped to 40 chars.
- **Menu-bar glyph** gains `StatusIcon.State.uploading`: the plain template bars with a small
  up-arrow knocked out top-right. Precedence recording > uploading > call detected > idle;
  `discreet` still flattens everything to the plain glyph.
- **Banner** — the saved card IS the upload card: "Recording saved (44m 31s, 6 parts)" /
  "Uploading to Darth Meetings — 43% · 298 MB of 696 MB", **no auto-hide**, **Show file** / OK, and
  `updateUpload(progress:)` rewrites the sub line in place (only while that recording's card is the
  one on screen). It ends as `showUploaded` ("Uploaded — transcribing now" / "“…” · 44m 31s ·
  696 MB in 1m 40s", **Open** / OK, 20 s) or `showUploadFailed` ("Upload failed — retrying in
  30 min" / the error, **Retry now** / OK, no auto-hide). An upload that did not come from a
  recording we just saved (PWA Upload, the 30-minute retry timer, the launch drain) gets the same
  live card via `showUploading(title:bytesTotal:recordingId:)`.
- **ws contract** (tray 0.3.9+, older trays simply omit the new fields):
  - `upload_progress {recording_id, segment, segments_total, bytes_sent, bytes_total, pct, title}`
    — ≥ 500 ms apart per recording, which is the ≤ 2/s the PWA's companion client promises.
  - `upload_done {recording_id, transcript_id, bytes_total, seconds}` (`seconds` = wall clock of
    the whole upload). The `upload_done` event in `events.jsonl` carries `bytes` + `seconds` too.
  - `upload_failed` unchanged.
  - every status payload gains
    `upload: {recording_id, title, pct, bytes_sent, bytes_total, segment, segments_total} | null`
    for the newest in-flight upload, so a PWA that connects mid-upload sees it.

**0.3.8 (2026-09-19) — delete from this Mac:** ws `delete_recording {recording_id}` →
`recording_deleted {recording_id, files_removed | error}`. Removes the recording's files and its
`~/Movies/Darth Recorder/<id>/` folder, keeps the registry row as `deleted` (PATCHed to the
server; a transcript already uploaded is untouched) and drops it from `list_recordings` (which
no longer returns deleted rows at all). Refused while that recording is live or uploading. The
PWA's upload picker / Settings list has a trash button per row.

**0.3.7 (2026-09-19) — no registry row stays "recording" forever:**
- `Registry.reconcileAfterLaunch()` runs before the launch upload drain: a row still at
  `recording` when the tray starts (a process that died mid-recording — the 2026-09-16
  main-queue zombie left 3936556e that way) becomes `local` when its files hold bytes (the
  drain then uploads it) or `upload_failed` ("capture never finished — the recorder was not
  running when the call ended"), `ended_at` set, and is PATCHed to the server
  (`registry_reconciled` event). Until now the PWA's upload picker showed such a row as a
  spinner that never resolved and the calendar row as "Recording on your Mac now…" for days.
- The "capture failed" path (writer exception at start) now sets `ended_at` and syncs the
  server too — 80eddbe9 stayed `recording` server-side while the Mac said `upload_failed`.
- `Registry.pendingUpload()` skips `upload_failed` rows with no file on disk, so a capture-failed
  row is no longer re-tried (and re-failed with "no files on disk") at every launch.

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
  **0.3.20 extends it:** memory pressure + swap (`mem_free_mb`, `mem_active_mb`, `mem_compressed_mb`,
  `swapins` / `swapouts` per sample, `swap_used_mb`, `mem_level_pct`, `mem_pressure`) and `low_power`
  in every sample; `recording` true|false, `call_app`, `call_pid`; live calls sampled every 30 s without a
  recording; `process_sample` (full only), `segment_closed`, `audio_overload`, `user_lag_report`,
  `unclean_exit` alongside — see the 0.3.20 block and *Telemetry levels*.
- **Preview gear** (`⚙` next to ✕): "Recording: <window>", **Auto — follow the call window**,
  **Re-detect the window now**, and **Record this instead:** every display and window the Record… dialog
  offers (call windows first). A pick rolls a new segment onto it (`source_switch` event with from / to /
  how; `source_mode` auto | manual in `status` and `recording_stopped`). ws: `redetect_source`,
  `set_auto_source`, `set_source {window_id|display_id}`, `set_discreet {enabled}`,
  `set_banner_auto_hide {enabled}`, `show_banner`, `hide_banner`, `resources`, `show_test_banner`,
  `snapshot_display {path, display_id?}` (an SCK display screenshot = what a sharing app sees).
- **Verified on the notarized 0.3.6 (2026-09-18 23:32–23:36 SGT):** `snapshot_display` with the test banner up vs
  hidden — 0 of 154,000 pixels differ in the banner's region, while an ordinary window at the same spot
  changes 39.9 % of them (positive control); a display recording kept local: the pill was hidden 13 s after
  start, `show_banner` brought it back, `set_source` to the second display rolled segment 2 (`source_mode`
  manual, `source_switch` event), `recording_stopped.resources` = CPU 6.9 % avg / 10.7 % max, 171 MB avg /
  239 MB max, 17.7 threads, CPU die 67 °C, 3 `resource_sample` events in 27 s; a window recording moved
  from the built-in display to the DELL mid-recording kept capturing (37 → 94 frames, teal content in the
  file before and after the move) — window capture follows the window across displays.

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
(whole-file sha256 as the fingerprint, `via: "blob"`, `recorderRecordingId`, `multi` for segments,
`dupAware` since 0.3.11 and `tracks: {count, mixFirst}` since 0.3.12) →
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

## Telemetry levels (0.3.20)

UserDefaults `telemetryLevel` = `full` (default; company Macs stay on it as per policy) | `partial` (a
personal Mac, the person's choice). Changed from Settings ▸ Telemetry in the tray menu, the first-launch
notice, or ws `set_telemetry_level {level}`. The decision is `TelemetryPolicy.allows(collector, level:)`
(TrayLogic, unit-tested) and every collector asks it BEFORE reading anything — a partial Mac never lists
processes or reads another app's GPU time only to drop it.

| | full | partial |
|---|---|---|
| Our own process: CPU %, memory footprint, threads | yes | yes |
| System-wide CPU / GPU utilisation, memory pressure, swap, thermal, die temps, battery, low power | yes | yes |
| Hardware model + specs (`hw_model`, chip, RAM, core counts, GPU cores) | yes | yes |
| Capture pipeline counters (`segment_closed`, `coreaudio_overloads`, `audio_overload`) | yes | yes |
| "This feels laggy" stamp with the machine snapshot (`user_lag_report.resources`) | yes | yes |
| Unclean previous exit + OUR OWN crash report (`unclean_exit`, `crash_report`) | yes | yes |
| `window_pick` with the CALL APP's own windows; `window_title_changed` for the recorded window | yes | yes |
| `window_pick` with EVERY on-screen window (owner, title, bounds, z) | yes | **no** |
| Top processes by CPU, per-process GPU time (`process_sample`, `user_lag_report.process_sample`) | yes | **no** |
| tray.log excerpts (`log_excerpt` — they name windows and apps) | yes | **no** |

Every event's payload carries `telemetry_level`. What partial does NOT change: the recorder's working
events (which call app was detected and its window title in `call_started`, the recording lifecycle,
uploads) — they are how the recorder works, not diagnostics; `call_app` in `resource_sample` /
`user_lag_report` names the same call app `call_started` already did. Nothing is ever collected from
another app's crash reports.

The menu: Settings ▸ Telemetry: Full ▸ Full ✓ / Partial, and a greyed hint under it — "Partial keeps
machine-level numbers only — for personal Macs". `telemetry_level_set {level, previous, source:
notice|menu|ws}` on every choice.

The notice is the ONLY telemetry prompt (Alok, 2026-10-01: nothing pops up when telemetry is sent, and
"This feels laggy" only flips its own menu title to "Lag report sent ✓" for 5 s). Shown once
(`telemetryNoticeShown`), 3 s after launch; non-modal, never in a screen share:

> **Darth Recorder now collects diagnostics while you are on a call.**
>
> This helps us find why recordings lag or lose audio on some Macs.
>
> Full telemetry (on now) also notes which apps are using CPU and GPU during a call. Company Macs stay
> on this setting as per policy.
>
> If this is your personal Mac, you can switch to partial telemetry, which keeps only machine-level
> numbers and nothing about other apps.
>
> You can change this at any time from the menu under Settings.
>
> [Keep full telemetry] (default) · [Switch to partial]

Test hooks (ws): `process_sample {seconds?}` → `process_sample_result` (null on partial), `report_lag`,
`show_telemetry_notice` (clears the flag and shows it again).

## Window-pick diagnostics (0.3.20)

So a bad pick can be reconstructed from the server: which windows existed, in what order, which rule
won, and why the others lost. Titles, owners, bounds and z-order only — NEVER pixels or thumbnails.

**`window_pick`** — one per decision, never per tick:
- `how`: `detect` (call started) | `start` (recording start) | `reresolve` (the 5 s re-resolve, ONLY when
  the picker's answer — window id + rule — changed; `previous` = the old signature; the source does not
  follow it by itself) | `roll` (share started / share ended) | `redetect` (`detail` = auto | redetect |
  pwa | tray …) | `manual` (a person picked a window) | `fallback` (window gone, hold elapsed) | `simulate`.
- `rule`: `teams_meeting_title`, `teams_non_nav_teams_window`, `teams_frontmost_non_nav`,
  `zoom_meeting_title`, `slack_huddle_title`, `whatsapp_call_title`, `meet_title`, `webex_meeting_title`,
  `frontmost`, `no_usable_window` (the picker's), or `manual`, `share`, `share_display`,
  `fallback_display`, `fallback_audio` (a choice that was not the picker's); `reason` = the human
  sentence; `order_key` = front-to-back `z_index`, the first usable window the rule matches wins, never area.
- `picked` and every entry of `candidates`: `window_id`, `title` ("" for an untitled window — included
  with its size, the Slack huddle case), `owner`, `pid`, `bounds {x, y, w, h}`, `display_id`, `layer`,
  `alpha`, `on_screen`, `z_index`, `call_app` (bool), and for the call app's windows `excluded` (null =
  usable, else `layer N` | `off screen` | `too small` — the ≤ 320×240 cut).
- `call {app, bundle_id, kind, pid}`, `call_window_count`, `untitled_call_windows` (usable ones),
  `recording_id` (from `start` on), `detail`.
- Tiers: **partial** → `candidates_scope: "call_app"`, the call app's own windows only (the meeting metadata
  the tray already shipped in `window_candidates`); **full** → `candidates_scope: "screen"`, every
  on-screen window at pick time (capped at 120; `screen_window_count` is the real number), so it shows what
  beat what.

**`window_title_changed {recording_id, window_id, old, new, at_s, segment}`** — the recorded window was
retitled (Teams moving from "Calendar | …" to the meeting, a Chrome tab switch). At most one per 10 s, and
always the net change since the last one logged (`TitleChangeTracker`). Both tiers (it is the recording's
own source).

Not collected: Accessibility (`ax_role` / `ax_subrole` / `ax_title`) — AX needs the Accessibility grant,
which the tray does not ask for, so it is skipped.

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
`{cmd:"set_auto_upload", enabled}`, `{cmd:"set_mic_processing", enabled}` (0.3.10 — voice
processing / echo cancellation on the mic; `mic_processing:{enabled,active}` rides in every
status snapshot), `{cmd:"mic_echo_probe", seconds?, processing?}` →
`{type:"mic_echo_probe_result", …}` (0.3.10 — measures how much of the speakers is in the mic;
refused with `error:"busy"` during a call or a recording; stores no audio).
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
