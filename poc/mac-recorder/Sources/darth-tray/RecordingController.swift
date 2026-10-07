import AppKit
import AVFoundation
import ScreenCaptureKit
import RecorderCore
import TrayLogic

/// One recording = one id, one folder, N segments, three tracks per segment.
///
/// - **Video** is the CALL WINDOW (`SCContentFilter(desktopIndependentWindow:)`), not the
///   display. If the window disappears we fall back to the display that contained it and log
///   it. When the call's app starts sharing, the video source switches to the shared window /
///   display for as long as the share lasts — each switch finishes the current segment and
///   starts the next one.
/// - **System audio** is a SECOND ScreenCaptureKit stream on the display containing the call
///   window (`capturesAudio`, `excludesCurrentProcessAudio`, a 16×16 video config whose frames
///   nobody consumes). It runs across segment boundaries and is written as audio track 1.
/// - **Microphone** is an `AVAudioEngine` tap, written as audio track 2. Never mixed with the
///   system track at capture.
///
/// Segments are `<base> part<N>.mp4` in `~/Movies/Darth Recorder/<recording-id>/`; each one
/// carries its own copy of the two audio tracks for its span.
final class RecordingController {
    enum State: String { case idle, starting, recording, stopping }

    enum Source {
        case window(CGWindowID, String)
        case display(CGDirectDisplayID)
        /// 0.2.9: no video at all — an `.m4a` with the system + mic tracks.
        case audio

        var label: String {
            switch self {
            case .window(let id, let title): return "window #\(id) \"\(title)\""
            case .display(let id): return "display \(id)"
            case .audio: return "audio only"
            }
        }
        var json: [String: Any] {
            switch self {
            case .window(let id, let title): return ["kind": "window", "window_id": Int(id), "title": title]
            case .display(let id): return ["kind": "display", "display_id": Int(id)]
            case .audio: return ["kind": "audio"]
            }
        }
        var isAudioOnly: Bool { if case .audio = self { return true }; return false }
        /// Identity for "is this the source we are already on?" — a dictionary's `description`
        /// has no stable key order, so comparing `json` could call two identical sources
        /// different and roll a pointless segment (0.3.15).
        var key: String {
            switch self {
            case .window(let id, _): return "w\(id)"
            case .display(let id): return "d\(id)"
            case .audio: return "audio"
            }
        }
    }

    /// How a detected call is captured (0.2.9). Voice-only calls have no window worth a video
    /// track (WhatsApp shows a tiny avatar card, a huddle is a sidebar, FaceTime audio nothing),
    /// and SCK hung on the WhatsApp voice window on 2026-09-16 — so those are audio-only.
    enum CaptureProfile: String { case audioOnly = "audio", window }
    static func profile(for call: DetectedCall) -> (CaptureProfile, String) {
        let t = call.title.lowercased()
        switch call.kind {
        case .whatsapp:
            // Look at EVERY window of the app, live: `call.title` alone was the main window's
            // ("WhatsApp") on both real voice calls, and the call card can appear after detection.
            // Unknown stays audio-only — the WhatsApp window is a Catalyst view SCK has hung on,
            // and a voice call has nothing worth a video track anyway (0.2.9 design).
            var titles = [t]
            if call.pid > 0 { titles += WindowPicker.candidates(pid: call.pid).map { $0.title.lowercased() } }
            if titles.contains(where: { $0.contains("video call") }) { return (.window, "WhatsApp video call") }
            if titles.contains(where: { $0.contains("voice call") }) { return (.audioOnly, "WhatsApp voice call") }
            return (.audioOnly, "WhatsApp call, kind unknown from the titles — audio only")
        case .slack: return (.audioOnly, "Slack huddle")
        case .facetime:
            if call.windowFrame == nil || t.contains("audio") { return (.audioOnly, "FaceTime audio") }
            return (.window, "FaceTime with a video window")
        default: return (.window, "\(call.kind.rawValue): window capture")
        }
    }

    /// What the user asked for (0.2.4 Record… dialog / ws `start` fields). The defaults are
    /// exactly the 0.2.3 behaviour: auto-picked source, both audio tracks, upload when signed in.
    struct RecordOptions {
        /// nil = auto: the call window when there is a call, else the main display.
        var source: Source? = nil
        var systemAudio = true
        var mic = true
        /// false = audio-only recording (`.m4a`, no SCK video stream, no window pick). nil = decide
        /// from the call's CaptureProfile (0.2.9).
        var video: Bool? = nil
        /// false = keep the file on this Mac: no automatic upload (the PWA / menu can still push it).
        var upload = true

        var json: [String: Any] {
            ["source": source?.json ?? "auto", "system_audio": systemAudio, "mic": mic, "upload": upload,
             "video": video ?? "auto"]
        }
        var summary: String {
            "video=\(video.map { $0 ? "on" : "off" } ?? "auto") audio=\(systemAudio ? "system" : "-")\(mic ? "+mic" : "") upload=\(upload)"
        }
    }

    private(set) var state: State = .idle
    private(set) var recordingId: String?
    private(set) var options = RecordOptions()

    /// 0.3.17: per-track mute for the running recording (AudioMenu). Both false at every start.
    struct AudioMute: Equatable { var system = false; var mic = false }
    private(set) var audioMute = AudioMute()
    /// True when the running recording captures the track and it is not muted.
    var systemAudioLive: Bool { options.systemAudio && !audioMute.system }
    var micLive: Bool { options.mic && !audioMute.mic }

    /// Mute / unmute a track of the RUNNING recording: silence is written in its place (the
    /// timeline and the live mix keep going), nothing is rolled. Returns the line for the
    /// banner. A track the recording was started without cannot be added here.
    func setAudioMuted(track: String, muted: Bool, how: String) -> String {
        guard state == .recording else { return "Not recording" }
        switch track {
        case "system":
            guard options.systemAudio else { return "This recording was started without system audio — it cannot be added mid-way" }
            guard audioMute.system != muted else { return "System audio is already \(muted ? "off" : "on")" }
            audioMute.system = muted
            audioForwarder.muted = muted
        case "mic":
            guard options.mic else { return "This recording was started without a microphone — it cannot be added mid-way" }
            guard audioMute.mic != muted else { return "Microphone is already \(muted ? "off" : "on")" }
            audioMute.mic = muted
            mic?.muted = muted
        default:
            return "Unknown track \(track)"
        }
        let at = Int(Date().timeIntervalSince(startedAt ?? Date()))
        let line = "\(track == "system" ? "System audio" : "Microphone") \(muted ? "off — silence is being recorded on that track" : "back on") (\(how), \(at)s in)"
        rlog("record: \(line)")
        EventLog.shared.log("audio_mute_change", ["recording_id": recordingId ?? "", "track": track, "muted": muted, "how": how, "at_s": at])
        return line
    }

    // MARK: start timeouts (0.2.8)
    /// Every awaited start step (shareable content, filter, stream start) races this deadline.
    /// 2026-09-16 21:23 SGT: SCK never called back for a WhatsApp voice-call window, `state`
    /// stayed .starting for good, every later Record click was ignored and even SIGTERM hung.
    static let VIDEO_START_TIMEOUT: TimeInterval = 8
    struct StartTimeout: Error { let step: String }
    /// Shared settle flag between the work / deadline / cancel branches of `timed` (main actor).
    final class StartRace<T> { var settled = false; var cont: CheckedContinuation<T, Error>? }
    private var startTask: Task<Void, Never>?
    private var startAttempt = 0
    private var simulatedStartHang: TimeInterval = 0
    /// Test hook: the next start sleeps this long inside a timed step (`simulate_start_hang`).
    func simulateStartHang(seconds: TimeInterval) { simulatedStartHang = seconds }
    private var simulatedStartException = false
    /// Test hook (0.3.1): the next start raises an NSException inside the guarded writer setup
    /// (`simulate_start_exception`) — must end as a normal `recording_failed`, app still alive.
    func simulateStartException() { simulatedStartException = true }

    /// Race one awaited start step against `deadline`. The SCK call itself cannot be cancelled:
    /// when it loses the race it is abandoned and `orphan` disposes of whatever it eventually
    /// returns. Cancelling the surrounding Task settles immediately with CancellationError.
    @MainActor
    private func timed<T>(_ step: String, deadline: Date, orphan: (@MainActor (T) -> Void)? = nil,
                          _ op: @escaping () async throws -> T) async throws -> T {
        let t0 = Date()
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw StartTimeout(step: step) }
        rlog("record: \(step)…")
        let box = StartRace<T>()
        let work = Task { try await op() }
        let value: T = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
                box.cont = cont
                Task { @MainActor in
                    do {
                        let v = try await work.value
                        if box.settled { rlog("record: \(step) finished \(Int(Date().timeIntervalSince(t0) * 1000)) ms in, after its deadline — discarded"); orphan?(v) }
                        else { box.settled = true; box.cont?.resume(returning: v) }
                    } catch {
                        if !box.settled { box.settled = true; box.cont?.resume(throwing: error) }
                    }
                }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
                    if !box.settled { box.settled = true; box.cont?.resume(throwing: StartTimeout(step: step)) }
                }
            }
        } onCancel: {
            Task { @MainActor in
                if !box.settled { box.settled = true; box.cont?.resume(throwing: CancellationError()) }
            }
        }
        rlog("record: \(step) took \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        return value
    }

    /// Undo a half-started capture (timeout / cancel): streams, writer, the empty segment file.
    @MainActor
    private func abortPartialStart(_ why: String) {
        let v = videoStream, a = audioStream, w = currentWriter()
        videoStream = nil; audioStream = nil; setWriter(nil)
        audioForwarder.sink = nil
        if v != nil || a != nil { willStopOwnStreams?((v != nil ? 1 : 0) + (a != nil ? 1 : 0)) }
        Task.detached {
            if let v { try? await v.stopCapture() }
            if let a { try? await a.stopCapture() }
            if let w { await w.finish(); try? FileManager.default.removeItem(at: w.url) }
        }
        rlog("record: partial start torn down (\(why))")
    }

    /// Stop / a second Record click / quit while the start is still pending: cancel it. Nothing
    /// was recorded, so the row is `upload_failed` "capture never started". Synchronous — the
    /// terminate path must never wait on this.
    func cancelStart(reason: String) {
        guard state == .starting, let id = recordingId else { return }
        rlog("record: cancelling pending start \(id) (\(reason))")
        startTask?.cancel(); startTask = nil
        state = .idle
        mic?.onBuffer = nil; mic?.stop(); mic = nil; micActive = false
        Task { @MainActor in self.abortPartialStart("cancelled: \(reason)") }
        Registry.shared.update(id, ["status": "upload_failed", "error": "capture never started (\(reason))", "ended_at": isoNow()])
        api?.syncRecording(id)
        EventLog.shared.log("recording_cancelled", ["recording_id": id, "reason": reason, "options": options.json],
                            summary: "record: start cancelled (\(reason)) — nothing recorded")
        call = nil; currentSource = nil
        onStartCancelled?(reason)
    }
    private(set) var startedAt: Date?
    private(set) var call: DetectedCall?
    private(set) var segments: [[String: Any]] = []
    private(set) var currentSource: Source?
    /// 0.3.6: "auto" (the picker chose the window and keeps following the call) or "manual"
    /// (the person picked a window / display from the preview's gear or the PWA).
    private(set) var sourceMode = "auto"
    private(set) var micActive = false
    /// 0.3.10: the `micVoiceProcessing` preference, copied in by the AppDelegate. Read ONCE,
    /// when a recording's mic starts — changing it mid-recording would mean tearing the input
    /// engine down and rolling a segment, so it takes effect on the next recording.
    /// 0.3.23: false by default — the voice-processing unit silences the recorder in the call itself.
    var micVoiceProcessing = false
    /// 0.3.16: the `micDeviceUID` preference (nil = automatic / system default), copied in by
    /// the AppDelegate. Read when a recording's mic starts; a change mid-recording goes through
    /// `switchMicDevice`, which restarts the live capture at once.
    var micDeviceUID: String?
    /// 0.3.10: what the current (or most recent) recording's mic ACTUALLY ran with, and the
    /// format its track was built from. Kept after `mic` is released so the stopped event and
    /// the ws status can still say so.
    private(set) var micProcessing: MicCapture.VoiceProcessing?
    private(set) var micFormatLabel: String?
    private(set) var micHardwareLabel: String?
    /// `true` / `false` / nil (no mic yet) — the "active" half of `mic_processing` in `status`.
    var micProcessingActive: Bool? { micProcessing.map { $0 == .on } }
    var fps = 5

    /// Main queue.
    var onStarted: (() -> Void)?
    var onSegment: ((Int, String) -> Void)?
    var onStopped: (([String: Any]) -> Void)?
    var onError: ((String) -> Void)?
    /// 0.2.6 audio health: a track went silent past its threshold (`ok == false`) or came back.
    /// Main queue. track ∈ "system" | "mic" | "video".
    var onTrackHealth: ((String, Bool) -> Void)?
    /// 0.2.8: a non-fatal notice for the banner (title, sub) — e.g. the window capture timed out
    /// and we fell back to the display.
    var onNotice: ((String, String) -> Void)?
    /// 0.2.8: a pending start was cancelled (Stop / second Record / quit) before it produced a file.
    var onStartCancelled: ((String) -> Void)?
    /// 0.3.0: downscale-worthy frames from the current writer (sample queue, ≤ 4 fps).
    var onPreviewFrame: ((CVPixelBuffer) -> Void)?
    /// Called before we tear our own SCK streams down, so the share detector can ignore the
    /// teardown lines they produce.
    var willStopOwnStreams: ((Int) -> Void)?
    var api: ApiClient?
    var deviceId = ""

    // capture state
    private var writer: Recorder?
    private let writerLock = NSLock()
    private var videoStream: SCStream?
    private var videoStopped = false
    private var audioStream: SCStream?
    private let audioForwarder = AudioForwarder()
    private var mic: MicCapture?
    private var segmentIndex = 0
    private var segmentStart = Date()
    /// 0.3.20: CoreAudio IO overloads on the mic's device, and the totals at the start of the
    /// current part (see `takeSegmentCounters`).
    private let overloads = AudioOverloadWatcher()
    private var segmentBase = SegmentCounters.zero
    private var dir: URL?
    private var base = ""
    private var rolling = false
    /// CG frame of the window we are recording, kept fresh by the 5 s re-resolve — the banner
    /// is placed on the display that contains THIS, not the frame the call was detected at.
    private(set) var lastWindowFrame: CGRect?
    /// Every segment of a recording keeps the FIRST segment's pixel size: the server stitches
    /// multi-file uploads with `ffmpeg -f concat -c copy`, which refuses inputs whose stream
    /// parameters differ. A differently-shaped source (a shared display after a call window)
    /// is letterboxed into it by SCK (`scalesToFit`).
    private var pinnedSize: (w: Int, h: Int)?
    /// 0.3.15: did this recording ask for video when it started? False for an audio-only
    /// profile (a Slack huddle, a WhatsApp voice call) or "video off" from the Record… dialog.
    /// The person can still add a video source mid-recording — but when THAT source goes away,
    /// such a recording falls back to audio, never to a display nobody asked to be captured.
    private var videoByDefault = true
    private var errorRolls = 0
    private var resolveTimer: Timer?
    private var shares: [[String: Any]] = []
    /// Window-gone hold (0.2.3): Slack closes the huddle window ~4 s BEFORE it releases the
    /// mic, and the detector needs 4.5 s to confirm a call end. Falling back to a display the
    /// moment the window vanishes therefore ended every huddle with a "Recording problem"
    /// banner and a few seconds of somebody's desktop. Now the video just stops (audio + mic
    /// keep flowing into the current writer) and we wait `WINDOW_GONE_HOLD` s: if the call
    /// ends in that window, the recording ends normally; only a call that is still live gets
    /// today's fallback.
    static let WINDOW_GONE_HOLD: TimeInterval = 6
    private var holdTimer: Timer?
    private var holdReason = ""
    /// Set by `noteCallEnded()`: the call this recording belongs to is over, so no source
    /// fallback may happen any more — the grace/stop path owns the ending.
    private var callOver = false
    private var loggedGoneAfterEnd = false

    // MARK: audio/video health (0.2.6)
    /// The other side is never quiet for 30 s on a real call; people do listen quietly for 3 min.
    static let SYSTEM_SILENT_S: TimeInterval = 30
    static let MIC_SILENT_S: TimeInterval = 180
    static let VIDEO_STALL_S: TimeInterval = 10
    private var healthTimer: Timer?
    private var systemStreamFailed: String?
    private var streamFailure = false
    private var lastVideoAt = Date()
    private var lastVideoCount = -1
    private var lastVideoWriter: ObjectIdentifier?
    private var videoFramesTotal = 0
    private var videoDupTotal = 0
    /// 0.3.12: does EVERY segment of this recording carry the live mix as its first audio
    /// track, and did that mix really hear both sources? Set when the first writer is built
    /// and ANDed with each segment's verdict as it closes; written to the registry as
    /// `mix_first`, which is what the uploader declares (`tracks.mixFirst`). False the moment
    /// one segment had no mix (a recording with a single source) or a mix that missed one.
    private var mixFirstOK = false
    /// 0.3.12: audio tracks per segment file — the mix (when there is one) plus the raw
    /// sources. Declared at upload as `tracks.count`.
    private var audioTrackCount = 0
    private var flags: [String: Bool] = [:]   // track → ok, transitions drive events/callback
    private var healthTicks = 0
    private var micDenied = false
    private var shareNoticeShown = false
    /// Set by the window-gone hold when the video stream died; cleared when the call ends inside
    /// the hold (the normal Slack/Teams end-of-call pattern — NOT a stream failure, 0.2.9).
    private var pendingVideoFailure = false

    var systemMeter: LevelMeter { audioForwarder.meter }
    var micMeter: LevelMeter? { mic?.meter }
    /// 0.3.2: AGC gain currently applied to the mic track, dB (0 when no mic / no gain).
    var micGainDb: Float { mic?.conditioner.gainDb ?? 0 }

    private func videoAliveCount() -> Int {
        guard let w = currentWriter() else { return lastVideoCount }
        return w.videoFrames + w.duplicatedFrames + w.idleFrames + w.droppedVideo
    }

    /// One pass per second while recording: fold counters, compute the three ticks, fire
    /// transitions (events + callback), log a health line every 60 s.
    private func healthTick() {
        guard state == .recording else { return }
        healthTicks += 1
        let now = Date()
        if let w = currentWriter() {
            let wid = ObjectIdentifier(w)
            let n = videoAliveCount()
            if wid != lastVideoWriter || n != lastVideoCount { lastVideoAt = now }
            lastVideoWriter = wid; lastVideoCount = n
        }
        micDeadTick()
        let h = health()
        for (track, ok) in [("video", h.videoOK), ("system", h.systemOK), ("mic", h.micOK)] {
            guard let ok else { continue }
            let prev = flags[track] ?? true
            flags[track] = ok
            guard ok != prev else { continue }
            let meter = track == "system" ? systemMeter : micMeter
            let payload: [String: Any] = [
                "recording_id": recordingId ?? "", "track": track,
                "silent_s": track == "video" ? Int(now.timeIntervalSince(lastVideoAt)) : Int(meter?.secondsSinceAudible ?? 0),
                "level": meter.map { Double($0.levelDb) } ?? NSNull(),
                "stream_alive": track == "system" ? (audioStream != nil) : (track == "mic" ? (mic != nil) : !videoStopped),
                "call": call?.json ?? NSNull(),
            ]
            EventLog.shared.log(ok ? "audio_resumed" : "audio_silent", payload,
                                summary: "health: \(track) \(ok ? "back" : "SILENT/STALLED") — \(healthLine())")
            onTrackHealth?(track, ok)
        }
        if healthTicks % 60 == 1 { rlog("health: \(healthLine()) · \(healthDetail())") }
    }

    struct Health { var videoOK: Bool?; var systemOK: Bool?; var micOK: Bool? }

    /// nil = the track was not requested. system ✗ needs a live call (a display recording with
    /// nothing playing is legitimately silent) unless the stream itself failed.
    func health() -> Health {
        var h = Health()
        guard state == .recording else { return h }
        if currentSource?.isAudioOnly == true {
            h.videoOK = nil
        } else if videoStopped {
            // Dead video is only a fault when the call is still live and no hold is pending.
            h.videoOK = callOver || holdTimer != nil
        } else {
            h.videoOK = Date().timeIntervalSince(lastVideoAt) < Self.VIDEO_STALL_S
        }
        if options.systemAudio {
            if audioStream == nil { h.systemOK = false }
            else if audioMute.system { h.systemOK = true }          // 0.3.17: silent on purpose
            else if call != nil && !callOver { h.systemOK = systemMeter.secondsSinceAudible < Self.SYSTEM_SILENT_S }
            else { h.systemOK = true }
        }
        if options.mic {
            if let m = mic {
                h.micOK = audioMute.mic ? true : (micDead.condition == nil && m.meter.secondsSinceAudible < Self.MIC_SILENT_S)
            } else { h.micOK = false }
        }
        return h
    }

    /// "video ✓ · mic ✓ · system ✗" — the banner sub line and the menu.
    func healthLine() -> String {
        let h = health()
        var parts: [String] = []
        func tick(_ ok: Bool?) -> String { ok == nil ? "–" : (ok! ? "✓" : "✗") }
        if currentSource?.isAudioOnly != true { parts.append("video \(tick(h.videoOK))") }
        if options.mic { parts.append(audioMute.mic ? "mic off" : (micDead.condition != nil ? "mic ✗ DEAD" : "mic \(tick(h.micOK))")) }
        if options.systemAudio {
            // Quiet system audio outside a call is neutral, not a fault.
            let quiet = audioStream != nil && !(call != nil && !callOver) && !systemMeter.audible
            parts.append(audioMute.system ? "system off" : (quiet ? "system ·" : "system \(tick(h.systemOK))"))
        }
        return parts.joined(separator: " · ")
    }

    private func healthDetail() -> String {
        var s = "video frames=\(videoFramesTotal + (currentWriter()?.videoFrames ?? 0)) stall=\(Int(Date().timeIntervalSince(lastVideoAt)))s"
        if options.systemAudio { s += " · system \(audioStream == nil ? "NO STREAM" : String(format: "%.0f dB", systemMeter.levelDb)) silent=\(Int(systemMeter.secondsSinceAudible))s bufs=\(systemMeter.buffers)" }
        if options.mic { s += " · mic \(mic == nil ? "NONE" : String(format: "%.0f dB", micMeter!.levelDb)) silent=\(Int(micMeter?.secondsSinceAudible ?? 0))s bufs=\(micMeter?.buffers ?? 0)\(mic.map { String(format: " gain=%+.0f dB ch=%d/%d", $0.conditioner.gainDb, $0.conditioner.channel + 1, $0.conditioner.hardwareChannels) } ?? "")" }
        return s
    }

    /// For the ws status payload: `audio: {system:{…}, mic:{…}, video:{…}}`.
    func healthJSON() -> [String: Any] {
        let h = health()
        var d: [String: Any] = [
            "video": ["ok": h.videoOK ?? NSNull(), "frames": videoFramesTotal + (currentWriter()?.videoFrames ?? 0),
                      "silent_s": Int(Date().timeIntervalSince(lastVideoAt)), "stream_alive": !videoStopped,
                      "audio_only": currentSource?.isAudioOnly == true] as [String: Any],
            "line": healthLine(),
        ]
        if options.systemAudio {
            var s = systemMeter.snapshot(); s["ok"] = h.systemOK ?? NSNull(); s["stream_alive"] = audioStream != nil
            if let e = systemStreamFailed { s["error"] = e }
            s["muted"] = audioMute.system                      // 0.3.17
            d["system"] = s
        }
        if options.mic {
            var m = micMeter?.snapshot() ?? ["level_db": -120, "audible": false, "silent_s": 0, "audible_s": 0, "buffers": 0]
            m["ok"] = h.micOK ?? NSNull(); m["stream_alive"] = mic != nil
            m["device"] = mic?.deviceJSON ?? NSNull()          // 0.3.16
            m["muted"] = audioMute.mic                         // 0.3.17
            d["mic"] = m
            d["mic_dead"] = micDeadJSON()                      // 0.3.18
        }
        return d
    }

    var isRecording: Bool { state == .recording || state == .starting }

    private func currentWriter() -> Recorder? {
        writerLock.lock(); defer { writerLock.unlock() }
        return writer
    }
    private func setWriter(_ w: Recorder?) {
        writerLock.lock(); writer = w; writerLock.unlock()
    }

    // MARK: start

    func start(call: DetectedCall?, displayOverride: CGDirectDisplayID? = nil) {
        var o = RecordOptions()
        if let d = displayOverride { o.source = .display(d) }
        start(call: call, options: o)
    }

    func start(call: DetectedCall?, options: RecordOptions) {
        guard state == .idle else { rlog("record: start ignored, state=\(state.rawValue)"); return }
        state = .starting
        self.call = call
        self.options = options
        audioMute = AudioMute()
        audioForwarder.muted = false
        let id = UUID().uuidString.lowercased()
        recordingId = id
        let now = Date()
        startedAt = now
        segments = []
        shares = []
        segmentIndex = 0
        callOver = false
        loggedGoneAfterEnd = false
        holdTimer?.invalidate(); holdTimer = nil
        systemStreamFailed = nil; streamFailure = false; flags = [:]; healthTicks = 0; micDenied = false
        micProcessing = nil; micFormatLabel = nil; micHardwareLabel = nil
        shareNoticeShown = false; pendingVideoFailure = false; currentSource = nil; sourceMode = "auto"
        lastPickSignature = nil; titleTracker = TitleChangeTracker(interval: 10)   // 0.3.20
        videoFramesTotal = 0; videoDupTotal = 0; lastVideoCount = -1; lastVideoWriter = nil
        // 0.3.21: the size is per recording — an audio-only start used to inherit the PREVIOUS
        // recording's size for its first video part (the 0.3.15 comment says it is set there).
        pinnedSize = nil
        resetCaptureProfile()                                                       // 0.3.21
        audioForwarder.reset()
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        base = "\(f.string(from: now)) \(call?.kind.rawValue ?? "display")"
        let folder = Paths.recordings.appendingPathComponent(id, isDirectory: true)
        dir = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        // Where to point the camera — or not at all.
        var source: Source
        var profileReason = "explicit"
        let profile: CaptureProfile? = call.map { Self.profile(for: $0).0 }
        if let call { profileReason = Self.profile(for: call).1 }
        let wantVideo = options.video ?? (profile != .audioOnly)
        videoByDefault = wantVideo
        if !wantVideo {
            source = .audio
            if options.video == false { profileReason = "video off by request" }
        } else if let chosen = options.source {
            source = chosen
        } else if let call, call.pid > 0 {
            let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
            lastPickSignature = pick.signature
            if let w = pick.window {
                source = .window(w.id, w.title)
                WindowPicker.logPick(how: "start", call: call, pick: pick, recordingId: id)
            } else {
                source = .display(call.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID())
                rlog("record: no call window found — falling back to \(source.label)")
                WindowPicker.logPick(how: "start", call: call, pick: pick, recordingId: id, detail: "no call window — \(source.label)",
                                     rule: "fallback_display")
            }
        } else {
            source = .display(call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID())
        }

        EventLog.shared.log("recording_starting", [
            "recording_id": id, "source": source.json, "call": call?.json ?? NSNull(), "dir": folder.path,
            "options": options.json, "profile": source.isAudioOnly ? "audio" : "window",
            "profile_reason": profileReason,
        ], summary: "record: starting \(id) on \(source.label) — \(profileReason) (\(options.summary))")

        Registry.shared.insert([
            "id": id,
            "started_at": isoString(now),
            "status": "recording",
            "call": call?.json ?? NSNull(),
            "files": [],
            "segments": [],
            "bytes": 0,
            "duration": 0,
            "transcript_id": NSNull(),
            "error": NSNull(),
            "matched": NSNull(),
            "upload": options.upload,
            "needs_sync": true,
        ])
        api?.syncRecording(id, insert: true)

        startAttempt += 1
        let attempt = startAttempt
        let begin: (AVAudioFormat?) -> Void = { [weak self] micFormat in
            guard let self else { return }
            guard self.state == .starting, self.recordingId == id else { rlog("record: start \(id) no longer pending — not capturing"); return }
            self.startTask = Task { @MainActor in
                @MainActor func fail(_ error: Error) {
                    guard self.recordingId == id, self.startAttempt == attempt, self.state == .starting else { return }
                    self.abortPartialStart("start failed")
                    self.mic?.stop(); self.mic = nil; self.micActive = false
                    self.state = .idle
                    // ended_at + sync (0.3.7): without the PATCH the server kept the row at
                    // 'recording' for good (80eddbe9, 2026-09-18 — its calendar row said
                    // "Recording on your Mac now…" for a day).
                    Registry.shared.update(id, ["status": "upload_failed", "error": "capture failed: \(error.localizedDescription)", "ended_at": isoNow(), "needs_sync": true])
                    self.api?.syncRecording(id)
                    EventLog.shared.log("recording_failed", ["recording_id": id, "error": error.localizedDescription],
                                        summary: "record: could not start — \(error.localizedDescription)")
                    self.onError?(error.localizedDescription)
                }
                do {
                    try await self.beginCapture(source: source, micFormat: micFormat)
                } catch is CancellationError {
                    rlog("record: start \(id) cancelled")
                } catch let t as StartTimeout {
                    guard self.recordingId == id, self.state == .starting else { return }
                    // Window capture never came up (WhatsApp, 2026-09-16): record the display it
                    // is on instead — the same fallback the window-gone path uses.
                    let display: CGDirectDisplayID
                    if case .window(let wid, _) = source, let f = ShareDetector.windowFrame(wid) { display = WindowPicker.display(containing: f) }
                    else { display = call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID() }
                    self.abortPartialStart("timeout at \(t.step)")
                    EventLog.shared.log("video_start_timeout", [
                        "recording_id": id, "step": t.step, "source": source.json, "seconds": Self.VIDEO_START_TIMEOUT,
                        "fallback": ["kind": "display", "display_id": Int(display)],
                    ], summary: "record: START TIMED OUT at \(t.step) on \(source.label) — falling back to display \(display)")
                    if case .display = source {
                        fail(NSError(domain: "record", code: 20, userInfo: [NSLocalizedDescriptionKey: "capture did not start within \(Int(Self.VIDEO_START_TIMEOUT)) s (\(t.step))"]))
                        return
                    }
                    self.onNotice?("Couldn't capture the call window", "Recording the display instead.")
                    do {
                        try await self.beginCapture(source: .display(display), micFormat: micFormat)
                    } catch is CancellationError {
                        rlog("record: fallback start \(id) cancelled")
                    } catch {
                        fail(error)
                    }
                } catch {
                    fail(error)
                }
                if self.startAttempt == attempt { self.startTask = nil }
            }
        }
        if !options.mic {
            // Asked for no microphone: never touch the device, never show the permission prompt.
            rlog("record: microphone off by request")
            begin(nil)
            return
        }
        // Mic first: the permission prompt must not race the capture start.
        MicCapture.requestPermission { [weak self] granted in
            guard let self else { return }
            EventLog.shared.log("mic_permission", ["granted": granted], summary: "record: microphone permission \(granted ? "granted" : "DENIED — recording without the mic track")")
            self.micDenied = !granted
            var micFormat: AVAudioFormat?
            if granted {
                let m = MicCapture(voiceProcessing: self.micVoiceProcessing, deviceUID: self.micDeviceUID)
                m.onRestarted = { [weak self] from, to, reason in self?.micRestarted(from: from, to: to, reason: reason) }
                do {
                    try m.start()
                    micFormat = m.format
                    m.muted = self.audioMute.mic
                    self.mic = m
                    self.micActive = true
                    // 0.3.10: the format AFTER voice processing had its say — that is what the
                    // writer's mic track is built from, and what the event log must report.
                    self.micProcessing = m.voiceProcessing
                    self.micFormatLabel = m.formatLabel
                    self.micHardwareLabel = m.hardwareFormatLabel
                } catch {
                    rlog("record: mic unavailable — \(error.localizedDescription)")
                    EventLog.shared.log("mic_failed", ["error": error.localizedDescription])
                }
            }
            begin(micFormat)
        }
    }

    /// The audio tracks of every segment, in file order, from the options: system first (when
    /// wanted), then the mic (when captured). Track INDICES follow from this — see `micTrack`.
    private func audioTracks(micFormat: AVAudioFormat?) -> [AudioTrackSpec] {
        var tracks: [AudioTrackSpec] = options.systemAudio ? [.system] : []
        if let micFormat { tracks.append(.mic(channels: Int(micFormat.channelCount), sampleRate: micFormat.sampleRate)) }
        return tracks
    }
    /// Index of the mic track in the writer: 1 after the system track, 0 when there is none.
    private var micTrack: Int { options.systemAudio ? 1 : 0 }

    @MainActor
    private func beginCapture(source: Source, micFormat: AVAudioFormat?) async throws {
        let deadline = Date().addingTimeInterval(Self.VIDEO_START_TIMEOUT)
        if simulatedStartHang > 0 {
            let s = simulatedStartHang; simulatedStartHang = 0
            rlog("record: TEST — simulating a \(Int(s)) s hang in the video start")
            try await timed("simulated hang", deadline: deadline) { try await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }
        }
        if simulatedStartException {
            simulatedStartException = false
            rlog("record: TEST — raising an NSException inside the guarded writer setup")
            try catchingObjC {
                NSException(name: .invalidArgumentException, reason: "simulated: Missing required key AVChannelLayoutKey", userInfo: nil).raise()
            }
        }
        let tracks = audioTracks(micFormat: micFormat)
        currentSource = source
        let url = segmentURL(1, for: source)
        let rec: Recorder
        let displayID: CGDirectDisplayID
        var w = 0, h = 0
        if source.isAudioOnly {
            // No SCK video stream, no window pick: just the two AAC tracks in an .m4a. The
            // system-audio stream still needs a display to attach to — the call's, else main.
            displayID = call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID()
            // catchingObjC (0.3.1): AVFoundation RAISES for bad settings; see ObjCSafe.swift.
            rec = try catchingObjC { try Recorder(audioOnlyURL: url, audioTracks: tracks) }
            rlog("record: audio-only writer → \(url.lastPathComponent)")
        } else {
            let (filter, did) = try await timed("shareable content + filter for \(source.label)", deadline: deadline) { try await Self.filter(for: source) }
            try Task.checkCancellation()
            displayID = did
            let t0 = Date()
            (w, h) = CaptureSession.pixelSize(of: filter)
            rlog("record: pixel size \(w)x\(h) took \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
            pinnedSize = (w, h)
            // 0.3.21: a recording that starts under pressure starts eased (`start` decided it).
            let profile = currentProfile
            let bitRate = Self.videoProfile(for: profile).videoBitRate
            rec = try catchingObjC { try Recorder(url: url, width: w, height: h, fps: fps, audioTracks: tracks, videoBitRate: bitRate) }
            rec.onStop = { [weak self] err in
                DispatchQueue.main.async { self?.videoStreamFailed(err) }
            }
            videoStream = try await timed("video stream start on \(source.label)", deadline: deadline,
                                          orphan: { s in Task { try? await s.stopCapture() } }) {
                try await Self.startVideoStream(filter: filter, profile: profile, output: rec, size: (w, h))
            }
            try Task.checkCancellation()
            streamProfile = profile
        }
        rec.onWriterFailure = { [weak self] err in self?.writerFailed(err) }
        rec.onPreviewFrame = { [weak self] pb in self?.onPreviewFrame?(pb) }
        setWriter(rec)
        // 0.3.12: with two sources the file's first audio track is the live mix; each segment's
        // verdict is ANDed in as it closes (`closeSegment`).
        mixFirstOK = rec.hasMix
        audioTrackCount = tracks.count + (rec.hasMix ? 1 : 0)
        segmentIndex = 1
        segmentStart = Date()
        videoStopped = source.isAudioOnly
        if options.systemAudio {
            audioForwarder.sink = { [weak self] sb in self?.currentWriter()?.appendAudio(sb, track: 0) }
            audioForwarder.onStopped = { [weak self] err in
                DispatchQueue.main.async { self?.systemStreamStopped(err) }
            }
            do {
                // Its own budget: a slow audio start must not cost the video its fallback.
                audioStream = try await timed("system audio stream start", deadline: Date().addingTimeInterval(Self.VIDEO_START_TIMEOUT),
                                              orphan: { s in Task { try? await s.stopCapture() } }) {
                    try await Self.startAudioStream(displayID: displayID, output: self.audioForwarder)
                }
                try Task.checkCancellation()
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                audioStream = nil
                systemStreamFailed = error.localizedDescription
                streamFailure = true
                rlog("record: system-audio stream failed to start — \(error.localizedDescription) — video\(mic == nil ? " only" : " + mic only")")
                EventLog.shared.log("system_audio_failed", [
                    "recording_id": recordingId ?? "", "error": error.localizedDescription, "display_id": Int(displayID),
                ], summary: "record: SYSTEM AUDIO FAILED TO START — \(error.localizedDescription)")
            }
        } else {
            audioForwarder.sink = nil
            audioStream = nil
            rlog("record: system audio off by request")
        }
        let micIndex = micTrack
        mic?.onBuffer = { [weak self] sb in self?.currentWriter()?.appendAudio(sb, track: micIndex) }

        state = .recording

        overloads.reset(recordingId: recordingId ?? "")
        attachOverloadWatcher()
        segmentBase = liveCounters()
        ResourceSampler.shared.beginRecording(id: recordingId ?? "")
        errorRolls = 0
        lastVideoAt = Date()
        healthTimer?.invalidate()
        resetMicDead()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.healthTick() }
        healthTimer?.tolerance = 0.2
        // 0.3.21: the mode changed while the stream was coming up.
        if let sp = streamProfile, sp != currentProfile {
            Task { @MainActor in await self.applyCaptureProfile(reason: "changed during the start") }
        }
        if case .window(let id, _) = source { lastWindowFrame = ShareDetector.windowFrame(id) }
        segments = [[
            "index": 1, "path": url.path, "source": source.json,
            "started_at": isoString(segmentStart), "bytes": 0, "seconds": 0,
        ]]
        persist(status: "recording")
        // Which tracks REALLY started: a file track with no stream behind it stays silent.
        var started: [String] = []
        if options.systemAudio && audioStream != nil { started.append("system") }
        if mic != nil { started.append("mic") }
        EventLog.shared.log("recording_started", [
            "recording_id": recordingId ?? "", "source": source.json, "width": w, "height": h,
            "tracks": tracks.map { $0.name }, "tracks_started": started,
            // 0.3.12: is the live mix being written as audio track 0?
            "mix_track": rec.hasMix,
            "system_stream": options.systemAudio ? (audioStream != nil) : NSNull(),
            "system_error": systemStreamFailed ?? NSNull(),
            "mic_stream": options.mic ? (mic != nil) : NSNull(),
            "mic_denied": micDenied,
            // 0.3.10: true | false | "unavailable" (asked for, refused by the system), and the
            // input format the mic track was actually built from.
            "mic_processing": mic?.voiceProcessingJSON ?? NSNull(),
            "mic_processing_requested": options.mic ? micVoiceProcessing : NSNull(),
            "mic_format": micFormatLabel ?? NSNull(),
            "mic_hw_format": micHardwareLabel ?? NSNull(),
            "mic_device": mic?.deviceJSON ?? NSNull(),         // 0.3.16
            "audio_display_id": Int(displayID),
            "path": url.path, "options": options.json,
            "capture_profile": currentProfile.rawValue, "capture_profile_mode": captureProfileMode.rawValue,   // 0.3.21
        ], summary: "record: \(recordingId ?? "") \(w)x\(h) tracks=[\(tracks.map { $0.name }.joined(separator: ","))] started=[\(started.joined(separator: ","))] \(options.summary) → \(url.lastPathComponent)")
        onStarted?()
        startResolveTimer()
    }

    // MARK: sources

    /// The file for part `index` — named for the source it is ABOUT to carry, not the one the
    /// recording is leaving. 0.3.15: `rollSegment` builds the URL before it moves
    /// `currentSource`, so reading the extension off `currentSource` gave every part after an
    /// audio↔video switch the previous part's extension (a window part called `.m4a`). The
    /// writer was always right; the name, the upload's `contentType` and "is this group mixed?"
    /// were not.
    private func segmentURL(_ index: Int, for source: Source) -> URL {
        return (dir ?? Paths.recordings).appendingPathComponent("\(base) part\(index).\(source.isAudioOnly ? "m4a" : "mp4")")
    }

    @MainActor
    private static func filter(for source: Source) async throws -> (SCContentFilter, CGDirectDisplayID) {
        let content = try await CaptureSession.shareableContent()
        switch source {
        case .window(let id, _):
            guard let w = content.windows.first(where: { $0.windowID == id }) else {
                throw NSError(domain: "record", code: 10, userInfo: [NSLocalizedDescriptionKey: "window \(id) is gone"])
            }
            return (SCContentFilter(desktopIndependentWindow: w), WindowPicker.display(containing: w.frame))
        case .audio:
            throw NSError(domain: "record", code: 13, userInfo: [NSLocalizedDescriptionKey: "audio-only source has no video filter"])
        case .display(let id):
            guard let d = content.displays.first(where: { $0.displayID == id }) ?? content.displays.first else {
                throw NSError(domain: "record", code: 11, userInfo: [NSLocalizedDescriptionKey: "no display"])
            }
            // 0.2.7: never record our own banner/panels. Display captures exclude this app
            // (window mode already captures only the call window; the audio stream keeps its
            // own filter — excludesCurrentProcessAudio covers audio).
            let me = Bundle.main.bundleIdentifier ?? "io.trames.darth.recorder"
            let ours = content.applications.filter { $0.bundleIdentifier == me }
            if ours.isEmpty { rlog("record: our app (\(me)) not in shareable content — display capture may include the banner") }
            return (SCContentFilter(display: d, excludingApplications: ours, exceptingWindows: []), d.displayID)
        }
    }

    /// 0.3.21: the SCK knobs of a capture level. `.audioOnly` (the policy's disabled hook) is
    /// never a video stream; should it ever reach here it gets the eased stream.
    static func videoProfile(for load: CaptureLoad) -> VideoCaptureProfile { load == .normal ? .normal : .eased }

    /// 0.3.21: the full video-stream configuration for a part of `size` under `profile` — used
    /// to create a stream (both creation sites: `beginCapture` and `rollSegment`) AND for the
    /// live switch (`updateConfiguration` replaces the whole configuration). The 0.3.20 colour
    /// pinning (sRGB in, 709 matrix) lives in `VideoCaptureProfile.streamConfiguration`.
    static func videoConfig(size: (w: Int, h: Int), profile: CaptureLoad) -> SCStreamConfiguration {
        videoProfile(for: profile).streamConfiguration(width: size.w, height: size.h)
    }

    private static func startVideoStream(filter: SCContentFilter, profile: CaptureLoad, output: Recorder, size: (w: Int, h: Int)? = nil) async throws -> SCStream {
        let (w, h) = size ?? CaptureSession.pixelSize(of: filter)
        let cfg = videoConfig(size: (w, h), profile: profile)
        let s = SCStream(filter: filter, configuration: cfg, delegate: output)
        try s.addStreamOutput(output, type: .screen, sampleHandlerQueue: output.queue)
        try await s.startCapture()
        return s
    }

    /// Audio-only companion stream: all system audio on that display, minimal video.
    private static func startAudioStream(displayID: CGDirectDisplayID, output: AudioForwarder) async throws -> SCStream {
        let content = try await CaptureSession.shareableContent()
        guard let d = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
            throw NSError(domain: "record", code: 12, userInfo: [NSLocalizedDescriptionKey: "no display for audio"])
        }
        let cfg = SCStreamConfiguration()
        cfg.width = 16; cfg.height = 16
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false
        cfg.queueDepth = 5
        cfg.capturesAudio = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true
        let s = SCStream(filter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg, delegate: output)
        try s.addStreamOutput(output, type: .audio, sampleHandlerQueue: output.queue)
        output.streamStartedAt = Date()
        rlog("record: starting system audio stream — display \(d.displayID) (\(d.width)x\(d.height), asked for \(displayID)), \(cfg.sampleRate) Hz × \(cfg.channelCount) ch, excludesCurrentProcessAudio=\(cfg.excludesCurrentProcessAudio)")
        try await s.startCapture()
        rlog("record: system audio stream on display \(d.displayID) started in \(Int(Date().timeIntervalSince(output.streamStartedAt ?? Date()) * 1000)) ms")
        return s
    }

    // MARK: segments

    /// Finish the current segment and start the next one with a different video source.
    func rollSegment(to source: Source, reason: String) {
        guard state == .recording, !rolling else { return }
        rolling = true
        let old = currentWriter()
        let oldStream = videoStream
        let oldIndex = segmentIndex
        let oldStart = segmentStart
        let oldDead = videoStopped
        Task { @MainActor in
            defer { self.rolling = false }
            do {
                let tracks = self.audioTracks(micFormat: self.mic?.format)
                let index = oldIndex + 1
                let url = self.segmentURL(index, for: source)
                let rec: Recorder
                var newStream: SCStream?
                var newProfile = self.currentProfile
                var w = 0, h = 0
                if source.isAudioOnly {
                    rec = try catchingObjC { try Recorder(audioOnlyURL: url, audioTracks: tracks) }
                } else {
                    let (filter, _) = try await Self.filter(for: source)
                    (w, h) = self.pinnedSize ?? CaptureSession.pixelSize(of: filter)
                    // A recording that STARTED audio-only has no pinned size yet: the first
                    // video part sets it, so every later video part keeps the same pixel size
                    // (the server's `-c copy` stitch refuses inputs that differ).
                    if self.pinnedSize == nil { self.pinnedSize = (w, h) }
                    // 0.3.21: the new part carries the current capture profile — without this a
                    // share start / window-gone / writer-error roll silently went back to 5 fps
                    // BGRA. Eased also means the lower bit rate (a writer's rate is fixed at
                    // creation, so it only changes when a part is created anyway).
                    newProfile = self.currentProfile
                    let bitRate = Self.videoProfile(for: newProfile).videoBitRate
                    rec = try catchingObjC { try Recorder(url: url, width: w, height: h, fps: self.fps, audioTracks: tracks, videoBitRate: bitRate) }
                    rec.onStop = { [weak self] err in
                        DispatchQueue.main.async { self?.videoStreamFailed(err) }
                    }
                    newStream = try await Self.startVideoStream(filter: filter, profile: newProfile, output: rec, size: (w, h))
                }
                rec.onWriterFailure = { [weak self] err in self?.writerFailed(err) }
                rec.onPreviewFrame = { [weak self] pb in self?.onPreviewFrame?(pb) }
                // Swap: audio + mic follow the current writer, so this is the cut point.
                self.setWriter(rec)
                let oldCounters = self.takeSegmentCounters()
                self.segmentIndex = index
                self.segmentStart = Date()
                self.currentSource = source
                self.videoStream = newStream
                self.streamProfile = newStream == nil ? nil : newProfile
                self.segments.append([
                    "index": index, "path": url.path, "source": source.json,
                    "started_at": isoString(self.segmentStart), "bytes": 0, "seconds": 0,
                ])
                // Retire the old one — but never call stopCapture on a stream the system
                // already tore down (that is what logged "Failed to stop a stream that is
                // already stopped" in 0.1.x).
                if !oldDead, let oldStream {
                    self.willStopOwnStreams?(1)
                    try? await oldStream.stopCapture()
                }
                self.videoStopped = source.isAudioOnly
                if let old {
                    await old.finish()
                    self.videoFramesTotal += old.videoFrames; self.videoDupTotal += old.duplicatedFrames
                    self.closeSegment(index: oldIndex, writer: old, started: oldStart, recordingId: self.recordingId ?? "",
                                      counters: oldCounters, reason: "roll: \(reason)")
                }
                self.persist(status: "recording")
                EventLog.shared.log("segment_started", [
                    "recording_id": self.recordingId ?? "", "segment": index, "reason": reason,
                    "source": source.json, "path": url.path, "width": w, "height": h,
                    "capture_profile": newStream == nil ? NSNull() : newProfile.rawValue,      // 0.3.21
                ], summary: "record: segment \(index) (\(reason)) → \(source.label)")
                self.onSegment?(index, reason)
                // 0.3.21: the profile changed while this roll was in flight — apply it once the
                // roll is over (a new main-actor task runs after this one's `rolling = false`).
                if newStream != nil, self.currentProfile != newProfile {
                    Task { @MainActor in await self.applyCaptureProfile(reason: "after a part roll") }
                }
            } catch {
                rlog("record: segment roll failed (\(reason)): \(error.localizedDescription) — staying on the current source")
                EventLog.shared.log("segment_roll_failed", ["reason": reason, "error": error.localizedDescription])
            }
        }
    }

    /// Mirror the in-memory segment list into the local registry (and PATCH the server).
    private func persist(status: String) {
        guard let id = recordingId else { return }
        let files = segments.compactMap { $0["path"] as? String }
        let bytes = segments.reduce(0) { $0 + (($1["bytes"] as? Int) ?? 0) }
        Registry.shared.update(id, [
            "status": status,
            "mix_first": mixFirstOK,
            "audio_tracks": audioTrackCount,
            "files": files,
            "segments": segments,
            "bytes": bytes,
            "duration": Int(Date().timeIntervalSince(startedAt ?? Date())),
            "shares": shares,
            "needs_sync": true,
        ])
        api?.syncRecording(id)
    }

    /// 0.3.20: called from the roll (main actor) and from the stop's detached task — it only
    /// reads the finished writer and logs (EventLog is lock-safe); `counters` was taken at the
    /// cut on the main queue (`takeSegmentCounters`).
    private func closeSegment(index: Int, writer w: Recorder, started: Date, recordingId id: String,
                              counters: SegmentCounters, reason: String) {
        let url = w.url
        mixFirstOK = mixFirstOK && w.mixHealthy
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        let secs = Int(Date().timeIntervalSince(started))
        if let i = segments.firstIndex(where: { ($0["index"] as? Int) == index }) {
            segments[i]["bytes"] = bytes
            segments[i]["seconds"] = secs
            segments[i]["ended_at"] = isoNow()
        }
        rlog("record: segment \(index) closed — \(w.stats) bytes=\(bytes) \(secs)s → \(url.lastPathComponent)")
        // Per-segment capture health (partial-OK: our own pipeline's counters, nothing else).
        func track(_ name: String) -> Int? { w.specs.firstIndex { $0.name == name } }
        let sys = track("system"), mic = track("mic")
        var e: [String: Any] = [
            "recording_id": id, "segment": index, "file": url.lastPathComponent, "seconds": secs, "bytes": bytes,
            "has_video": w.hasVideo,
            "video": w.videoFrames, "dup": w.duplicatedFrames, "idle": w.idleFrames,
            "dropped_not_ready": w.droppedVideoNotReady, "dropped_append_failed": w.droppedVideoAppendFailed,
            "audio_not_ready_system": sys.map { w.audioNotReady[$0] } ?? NSNull(),
            "audio_not_ready_mic": mic.map { w.audioNotReady[$0] } ?? NSNull(),
            "system_buffers": sys.map { w.audioBuffers[$0] } ?? NSNull(),
            "mic_buffers": mic.map { w.audioBuffers[$0] } ?? NSNull(),
            "mix_backpressure": w.hasMix ? w.mixBackpressure : NSNull(),
            "mix_healthy": w.hasMix ? w.mixHealthy : NSNull(),
            "reason": reason,
        ]
        for (k, v) in counters.json { e[k] = v }
        EventLog.shared.log("segment_closed", e)
    }

    // MARK: window-pick diagnostics (0.3.20)

    /// The picker's last answer for this recording ("window id|rule"): a re-resolve logs only
    /// when it changes.
    private var lastPickSignature: String?
    private var titleTracker = TitleChangeTracker(interval: 10)

    /// A source chosen by something other than the picker (a share, a manual pick): the event
    /// still carries the picker's view and the candidates, with `picked` = what was chosen.
    private func logSourcePick(how: String, rule: String, target: Source, detail: String) {
        let pick = call.flatMap { $0.pid > 0 ? WindowPicker.pick(kind: $0.kind, pid: $0.pid) : nil }
            ?? WindowPicker.Pick(window: nil, candidates: [], reason: "no call app to pick for", rule: "none",
                                 screen: WindowPicker.onScreenWindows())
        var chosen: WindowCandidate?
        if case .window(let wid, _) = target { chosen = pick.screen.first { $0.id == wid } }
        WindowPicker.logPick(how: how, call: call, pick: pick, recordingId: recordingId, detail: detail, picked: .some(chosen), rule: rule)
    }

    /// The recorded window's title changed: `window_title_changed`, at most one per 10 s, the net
    /// change since the last one logged. (The recorded window's title is already the source's
    /// title in the recording's own events — partial-OK.)
    private func noteTitle(id: CGWindowID, title: String) {
        guard Telemetry.allows(.callWindows),
              let ch = titleTracker.observe(windowId: id, title: title, now: ProcessInfo.processInfo.systemUptime) else { return }
        EventLog.shared.log("window_title_changed", [
            "recording_id": recordingId ?? "", "window_id": Int(id), "old": ch.old, "new": ch.new,
            "at_s": Int(Date().timeIntervalSince(startedAt ?? Date())), "segment": segmentIndex,
        ], summary: "record: recorded window #\(id) retitled “\(ch.old)” → “\(ch.new)”")
    }

    // MARK: per-segment counters (0.3.20)

    /// Recording-lifetime totals that segments are cut out of: the mic's gap fills and the
    /// CoreAudio overloads on its device.
    private func liveCounters() -> SegmentCounters {
        SegmentCounters(micGapsFilled: mic?.gapsFilled ?? 0, micGapSeconds: mic?.gapFilledSeconds ?? 0,
                        coreaudioOverloads: overloads.count)
    }

    /// The closing part's share of the totals; the totals become the next part's baseline.
    /// Main queue, at the cut.
    private func takeSegmentCounters() -> SegmentCounters {
        let now = liveCounters()
        let d = now.delta(since: segmentBase)
        segmentBase = now
        return d
    }

    /// Put the overload listener on the mic's device (and the input unit's, under voice
    /// processing). Main queue; again after every mic restart.
    private func attachOverloadWatcher() {
        guard let m = mic else { overloads.detach(); return }
        overloads.watch(devices: [m.deviceID ?? AudioDevices.defaultInputID, m.unitDeviceID], label: m.deviceName ?? "microphone")
    }

    /// The video stream died — the recorded window was closed, the app quit, or the system
    /// tore the stream down. The plan says: fall back to the display that contained it and log
    /// it. Only give up after three of these.
    private func videoStreamFailed(_ err: Error) {
        guard state == .recording, currentSource?.isAudioOnly != true else { return }
        videoStopped = true
        pendingVideoFailure = true
        if callOver { streamFailure = true }   // died after the call ended: nothing to hold for
        EventLog.shared.log("video_stream_error", [
            "recording_id": recordingId ?? "", "error": err.localizedDescription, "call_over": callOver,
        ], summary: "record: video stream died (\(err.localizedDescription))\(callOver ? " after call end — audio continues until stop" : " — holding for a call end")")
        // Audio + mic keep flowing into the current writer; only the video stops. Fall back
        // to another source only if the call turns out to be still live.
        beginWindowGoneHold(reason: err.localizedDescription)
    }

    /// The system-audio SCK stream died mid-recording (0.2.6: shipped as an event; before, one
    /// tray.log line nobody saw). The recording continues with whatever tracks are left.
    private func systemStreamStopped(_ err: Error) {
        guard state == .recording else { return }
        audioStream = nil
        streamFailure = true
        systemStreamFailed = err.localizedDescription
        EventLog.shared.log("system_audio_stopped", [
            "recording_id": recordingId ?? "", "error": err.localizedDescription,
            "buffers": systemMeter.buffers, "level": Double(systemMeter.levelDb),
        ], summary: "record: SYSTEM AUDIO STREAM STOPPED — \(err.localizedDescription) (after \(systemMeter.buffers) buffers)")
    }

    /// The AVAssetWriter failed: nothing more will be written to this file, so stop instead of
    /// pretending to record (0.2.0 shipped one of these during testing — never again silently).
    private func writerFailed(_ err: Error) {
        guard state == .recording else { return }
        errorRolls += 1
        streamFailure = true
        EventLog.shared.log("writer_failed", [
            "recording_id": recordingId ?? "", "error": String(describing: err), "attempt": errorRolls,
        ], summary: "record: WRITER FAILED — \(err.localizedDescription) (attempt \(errorRolls))")
        // A fresh segment on the same source costs a second and saves the rest of the meeting;
        // three failures in a row means it is not going to work.
        guard errorRolls <= 3, let source = currentSource else {
            onError?("The recording could not be encoded (\(err.localizedDescription)) — stopped.")
            stop(reason: "writer failed")
            return
        }
        onError?("Hiccup while encoding — continuing in a new part.")
        rollSegment(to: source, reason: "writer failed")
    }

    // MARK: share awareness

    /// A share belongs to this call when the bundle ids are the same family — Teams shares as
    /// `com.microsoft.teams2.modulehost` while the call is `com.microsoft.teams2`.
    private func related(_ share: ShareInfo) -> Bool {
        guard let call, !call.bundleId.isEmpty else { return true }   // display recording: follow any share
        return share.appBundle.hasPrefix(call.bundleId) || call.bundleId.hasPrefix(share.appBundle)
    }

    func shareStarted(_ share: ShareInfo) {
        guard state == .recording else { return }
        shares.append(share.json)
        if currentSource?.isAudioOnly == true {
            // v1: no video part for an audio-only recording — say so once, log every share.
            EventLog.shared.log("share_not_captured", ["recording_id": recordingId ?? "", "share": share.json],
                                summary: "record: share by \(share.appName ?? share.appBundle) NOT captured — audio-only recording")
            if !shareNoticeShown {
                shareNoticeShown = true
                onNotice?("Screen share not captured", "This call records audio only — pick a video source in the recorder menu to capture it.")
            }
            return
        }
        guard related(share) else {
            rlog("record: share by \(share.appBundle) is not this call's app (\(call?.bundleId ?? "-")) — video source unchanged")
            return
        }
        var source: Source?
        if let wid = share.windowID { source = .window(wid, share.windowTitle ?? "") }
        else if let did = share.displayID { source = .display(did) }
        guard let source else { return }
        logSourcePick(how: "roll", rule: share.windowID != nil ? "share" : "share_display", target: source,
                      detail: "share started (\(share.appName ?? share.appBundle))")
        rollSegment(to: source, reason: "share started (\(share.appName ?? share.appBundle))")
    }

    func shareEnded(_ share: ShareInfo) {
        guard state == .recording else { return }
        if let i = shares.firstIndex(where: { ($0["id"] as? String) == share.id }) {
            shares[i]["ended_at"] = isoNow()
        }
        guard currentSource?.isAudioOnly != true, related(share) else { return }
        // 0.3.15: an audio-only-by-default recording only has video because the person picked
        // the shared window. The share is over — go back to audio, not to somebody's desktop.
        if !videoByDefault {
            rollSegment(to: .audio, reason: "share ended, audio-only recording")
            return
        }
        // Back to the call window (re-resolved: it may have moved while the share was up).
        guard let call, call.pid > 0 else {
            if let f = call?.windowFrame { rollSegment(to: .display(WindowPicker.display(containing: f)), reason: "share ended") }
            return
        }
        let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
        lastPickSignature = pick.signature
        if let w = pick.window {
            WindowPicker.logPick(how: "roll", call: call, pick: pick, recordingId: recordingId, detail: "share ended")
            rollSegment(to: .window(w.id, w.title), reason: "share ended")
        } else {
            WindowPicker.logPick(how: "roll", call: call, pick: pick, recordingId: recordingId, detail: "share ended, no call window",
                                 rule: "fallback_display")
            rollSegment(to: .display(CGMainDisplayID()), reason: "share ended, no call window")
        }
    }

    // MARK: liveness

    private func startResolveTimer() {
        resolveTimer?.invalidate()
        resolveTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.reresolve() }
        resolveTimer?.tolerance = 1
    }

    /// Every 5 s while recording: make sure the window we are pointed at still exists, note a
    /// title change of the recorded window, and — 0.3.20 — log the picker's view only when its
    /// answer CHANGED (it used to log the whole candidate list on every tick).
    private func reresolve() {
        guard state == .recording, currentSource?.isAudioOnly != true else { return }
        if case .window(let id, _)? = currentSource, let info = ShareDetector.windowInfo(id) { noteTitle(id: id, title: info.title) }
        guard let call, call.pid > 0 else { return }
        let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
        if pick.signature != lastPickSignature {
            WindowPicker.logPick(how: "reresolve", call: call, pick: pick, recordingId: recordingId,
                                 detail: "the picker's answer changed (the source only follows it on a re-detect, a share end or a fallback)",
                                 previous: lastPickSignature ?? NSNull())
            lastPickSignature = pick.signature
        }
        guard case .window(let id, _)? = currentSource else { return }
        if let f = ShareDetector.windowFrame(id) { lastWindowFrame = f }
        if ShareDetector.windowInfo(id) == nil {
            // The window we were recording is gone — hold, do not fall back yet.
            beginWindowGoneHold(reason: "recorded window disappeared")
        }
    }

    // MARK: source control (0.3.6)

    /// Run the window picker again for the call being recorded; roll a new segment when it
    /// picks a different window. Returns a one-line outcome for the log / the caller's banner.
    @discardableResult
    func redetectSource(how: String = "redetect") -> String {
        guard state == .recording, currentSource?.isAudioOnly != true else { return "not recording video" }
        guard let call, call.pid > 0 else { return "no call window to look for — this recording is a display / manual pick" }
        let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
        WindowPicker.logPick(how: "redetect", call: call, pick: pick, recordingId: recordingId, detail: how)
        lastPickSignature = pick.signature
        guard let w = pick.window else {
            EventLog.shared.log("source_redetect", ["recording_id": recordingId ?? "", "how": how, "outcome": "no_window", "from": currentSource?.json ?? NSNull()],
                                summary: "record: re-detect found no window for \(call.appName) — keeping \(currentSource?.label ?? "?")")
            return "no window found for \(call.appName) — keeping the current source"
        }
        if case .window(let id, _)? = currentSource, id == w.id {
            EventLog.shared.log("source_redetect", ["recording_id": recordingId ?? "", "how": how, "outcome": "same", "window_id": Int(w.id), "title": w.title])
            return "already recording \"\(w.title)\""
        }
        let from: Any = currentSource?.json ?? NSNull()
        sourceMode = "auto"
        rollSegment(to: .window(w.id, w.title), reason: "\(how): picker now says \"\(w.title)\"")
        EventLog.shared.log("source_switch", ["recording_id": recordingId ?? "", "how": how, "from": from, "to": ["kind": "window", "window_id": Int(w.id), "title": w.title], "rule": pick.reason],
                            summary: "record: source switched by \(how) → window #\(w.id) \"\(w.title)\"")
        return "now recording \"\(w.title)\""
    }

    /// The person picked a source (preview gear / tray menu / PWA): roll onto it and stop
    /// following the call window (the picker's re-resolve keeps checking the window still
    /// exists).
    ///
    /// 0.3.15: this is also how an AUDIO-ONLY recording gains video. The per-app capture
    /// profile (`profile(for:)`) is only ever the DEFAULT — once the person picks, their pick
    /// owns the rest of the recording. Picking a display / window on an audio-only recording
    /// closes the `.m4a` part and opens an `.mp4` one on the same part-rotation path a share
    /// flip uses (the audio tracks carry on unchanged: mix + system + mic); picking `.audio`
    /// on a video recording rotates back to an audio-only part. Nothing here happens without
    /// an explicit pick.
    func switchSource(to source: Source, title: String, how: String = "manual") -> String {
        guard state == .recording else { return "not recording" }
        if let cur = currentSource, cur.key == source.key {
            return source.isAudioOnly ? "already recording audio only" : "already recording \(title)"
        }
        let from: Any = currentSource?.json ?? NSNull()
        let wasAudioOnly = currentSource?.isAudioOnly == true
        // A pending window-gone hold belongs to the source we are leaving: if it fired after
        // this switch it would roll onto a display nobody picked.
        if holdTimer != nil { holdTimer?.invalidate(); holdTimer = nil; pendingVideoFailure = false }
        sourceMode = "manual"
        if !source.isAudioOnly { logSourcePick(how: "manual", rule: "manual", target: source, detail: how) }
        rollSegment(to: source, reason: "\(how): \(title)")
        EventLog.shared.log("source_switch", [
            "recording_id": recordingId ?? "", "how": how, "from": from, "to": source.json, "title": title,
            "from_audio_only": wasAudioOnly, "to_audio_only": source.isAudioOnly,
        ], summary: "record: source switched by \(how) → \(source.label)\(wasAudioOnly && !source.isAudioOnly ? " (video added to an audio-only recording)" : "")")
        if source.isAudioOnly { return "now recording audio only" }
        return wasAudioOnly ? "video added — now recording \(title)" : "now recording \(title)"
    }

    // MARK: 0.3.16 — microphone device

    /// "MacBook Pro Microphone (default)" while a recording's mic runs; nil otherwise.
    var micDeviceLabel: String? { mic?.deviceLabel }
    var micDeviceName: String? { mic?.deviceName }
    var micRestarts: Int { mic?.restarts ?? 0 }

    /// The person picked a microphone (nil = automatic). Live recording → the capture restarts
    /// on it now; idle → remembered for the next recording (the AppDelegate owns the pref).
    func switchMicDevice(uid: String?, name: String, how: String) -> String {
        micDeviceUID = uid
        guard state == .recording, let m = mic else {
            EventLog.shared.log("mic_device_pick", ["how": how, "uid": uid ?? NSNull(), "name": name, "live": false],
                                summary: "mic: device preference → \(name) — takes effect on the next recording")
            return "\(name) — from the next recording"
        }
        let out = m.switchDevice(uid: uid)
        EventLog.shared.log("mic_device_pick", ["recording_id": recordingId ?? "", "how": how, "uid": uid ?? NSNull(), "name": name, "live": true, "outcome": out],
                            summary: "mic: device picked by \(how) → \(name) — \(out)")
        return "now capturing from \(out)"
    }

    /// Restart the live mic capture on whatever device is wanted right now.
    func redetectMic(how: String) -> String {
        guard state == .recording, let m = mic else { return "not recording" }
        let ok = m.restart(reason: "\(how): re-detect")
        return ok ? "restarting the microphone on \(micDeviceUID == nil ? "the system default" : "the chosen device")…" : "could not restart the microphone — see the log"
    }

    /// The capture restarted itself (device change, watchdog) — tell the person only when the
    /// device actually changed; a same-device recovery is a log line.
    private func micRestarted(from: String?, to: String?, reason: String) {
        micFormatLabel = mic?.formatLabel
        micHardwareLabel = mic?.hardwareFormatLabel
        micProcessing = mic?.voiceProcessing
        // 0.3.20: the overload listener follows the capture onto its new device.
        if state == .recording { attachOverloadWatcher() }
        // 0.3.18: a dead-mic fallback / re-detect already has its own banner that must stay up.
        if micDeadOwnsRestart { micDeadOwnsRestart = false; return }
        guard from != to, let to else { return }
        onNotice?("Microphone changed", "Now capturing from \(to)\(from.map { " (was \($0))" } ?? "")")
    }

    // MARK: dead microphone (0.3.18)
    //
    // 2026-09-25 16:05 SGT: the mic was hand-switched to "Microsoft Teams Audio" (a loopback
    // driver) and a 48-minute call recorded digital silence on the mic track while the other
    // side was audible throughout. The decision is `MicDeadDetector` (TrayLogic, unit-tested);
    // this feeds it once a second from the health tick and hands a detection to the app
    // (`onMicDead`), which owns the pick and the banner.

    private var micDead = MicDeadDetector()
    private var micDeadSystemAudibleSeen = 0
    /// Set just before a dead-mic fallback / re-detect restarts the capture: the "Microphone
    /// changed" notice of that restart would replace the banner that must stay up.
    private var micDeadOwnsRestart = false
    /// What the app did about the last detection ("fallback" | "redetect" | "told"), for status.
    private(set) var micDeadLastAction: String?
    private var micDeadLastDevice: String?
    /// Main queue: (detection, the device it happened on).
    var onMicDead: ((MicDeadDetector.Detection, String?) -> Void)?

    private func resetMicDead() {
        micDead = MicDeadDetector()
        micDeadSystemAudibleSeen = systemMeter.audibleSeconds
        micDeadLastAction = nil; micDeadLastDevice = nil; micDeadOwnsRestart = false
        _ = mic?.takeTickStats()
    }

    private func micDeadTick() {
        let stats = mic?.takeTickStats() ?? (buffers: 0, peakDb: -120, rmsDb: -120)
        let sysSeen = systemMeter.audibleSeconds
        let systemAudible = sysSeen != micDeadSystemAudibleSeen
        micDeadSystemAudibleSeen = sysSeen
        let k = MicDeadDetector.Tick(
            t: ProcessInfo.processInfo.systemUptime, active: options.mic && mic != nil, muted: audioMute.mic,
            micRestarts: mic?.restarts ?? 0, micBuffers: stats.buffers, micPeakDb: stats.peakDb, micRmsDb: stats.rmsDb,
            systemLive: systemAudioLive && audioStream != nil, systemAudible: systemAudible)
        guard let d = micDead.tick(k) else { return }
        let device = mic?.deviceName
        micDeadLastDevice = device
        EventLog.shared.log("mic_dead_detected", [
            "recording_id": recordingId ?? "", "reason": d.reason.rawValue, "device": device ?? NSNull(),
            "device_label": mic?.deviceLabel ?? NSNull(), "mode": micDeviceUID == nil ? "auto" : "manual",
            "silent_s": d.silentSeconds, "system_audible_s": d.systemAudibleSeconds, "follow_up": d.followUp,
            "simulated": mic?.simulatedDead?.rawValue ?? NSNull(),
            "at_s": Int(Date().timeIntervalSince(startedAt ?? Date())),
        ], summary: "mic: DEAD\(d.followUp ? " (still, after a re-detect)" : "") — \(d.reason.rawValue) on \(device ?? "?") for \(d.silentSeconds) s, system audible \(d.systemAudibleSeconds) s of the last minute")
        onMicDead?(d, device)
    }

    /// The dead mic was a manual pick: back to Automatic (the app has already cleared the pref).
    /// Returns the device the capture is moving to.
    func micDeadFallback(from: String?) -> String {
        guard state == .recording, mic != nil else { return "not recording" }
        micDeadOwnsRestart = true
        let to = AudioDevices.defaultInputID.flatMap { AudioDevices.name(of: $0) } ?? "the system default"
        let out = switchMicDevice(uid: nil, name: "Automatic", how: "mic_dead")
        // A restart that fails never reports back — do not let the flag eat a later, real notice.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.micDeadOwnsRestart = false }
        micDeadLastAction = "fallback"
        EventLog.shared.log("mic_dead_fallback", ["recording_id": recordingId ?? "", "from": from ?? NSNull(), "to": to, "outcome": out],
                            summary: "mic: dead mic \(from ?? "?") → Automatic (\(to))")
        return to
    }

    /// The dead mic was already Automatic: restart it on whatever the default is now, and look
    /// again in 30 s.
    func micDeadRedetect() -> String {
        guard state == .recording, mic != nil else { return "not recording" }
        micDeadOwnsRestart = true
        let out = redetectMic(how: "mic_dead")
        // A restart that fails never reports back — do not let the flag eat a later, real notice.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in self?.micDeadOwnsRestart = false }
        micDead.armFollowUp(at: ProcessInfo.processInfo.systemUptime)
        micDeadLastAction = "redetect"
        EventLog.shared.log("mic_dead_redetect", ["recording_id": recordingId ?? "", "device": micDeadLastDevice ?? NSNull(), "outcome": out])
        return out
    }

    func micDeadTold() { micDeadLastAction = "told" }

    /// ws `simulate_mic_dead {mode: "zero"|"quiet"|"low"|null}`.
    func simulateMicDead(_ mode: String?) -> String {
        guard state == .recording, let m = mic else { return "not recording with a microphone" }
        guard mode == nil || MicCapture.SimulatedDead(rawValue: mode!) != nil else { return "unknown mode \(mode!)" }
        m.simulatedDead = mode.flatMap { MicCapture.SimulatedDead(rawValue: $0) }
        rlog("TEST — simulate_mic_dead \(mode ?? "off")")
        EventLog.shared.log("test_simulate_mic_dead", ["recording_id": recordingId ?? "", "mode": mode ?? NSNull()])
        return "simulated dead mic: \(mode ?? "off")"
    }

    func micDeadJSON() -> [String: Any] {
        let c = micDead.condition
        var d: [String: Any] = [
            "active": c != nil, "reason": c?.reason.rawValue ?? NSNull(), "silent_s": c?.silentSeconds ?? 0,
            "system_audible_s": c?.systemAudibleSeconds ?? 0, "detections": micDead.detections,
            "follow_up_pending": micDead.followUpPending, "last_action": micDeadLastAction ?? NSNull(),
            "simulated": mic?.simulatedDead?.rawValue ?? NSNull(),
        ]
        if let last = micDead.lastDetection, let at = micDead.lastDetectedAt {
            d["last"] = ["reason": last.reason.rawValue, "silent_s": last.silentSeconds, "system_audible_s": last.systemAudibleSeconds,
                         "follow_up": last.followUp, "device": micDeadLastDevice ?? NSNull(),
                         "ago_s": Int(ProcessInfo.processInfo.systemUptime - at)] as [String: Any]
        }
        return d
    }

    // MARK: capture profile (0.3.21)
    //
    // A fanless MacBook Air sat at 100 % system GPU and thermal "fair" for whole Teams calls
    // while we captured her 2304×1472 px window at 5 fps BGRA. Under pressure the LIVE stream
    // is eased (2 fps, 420v, no cursor, queue depth 4) with `SCStream.updateConfiguration` —
    // never by rolling a part (a part with other stream parameters costs a server re-encode).
    // The decision is `CaptureEasePolicy` (TrayLogic, unit-tested); this feeds it from every
    // 10 s recording sample and from the thermal / power notifications, applies what it says,
    // and carries the profile through every stream this recording creates.

    /// Settings ▸ Capture / ws `set_capture_profile_mode` — set through `setCaptureProfileMode`.
    private(set) var captureProfileMode: CaptureProfileMode = .auto
    /// What this recording WANTS: every video stream created from now on starts with it.
    private(set) var currentProfile: CaptureLoad = .normal
    /// What the live video stream really runs with (nil = no live video stream).
    private(set) var streamProfile: CaptureLoad?
    private var easePolicy = CaptureEasePolicy()
    private var easedSince: Date?
    private var easedAccum: TimeInterval = 0
    private var profileChanges = 0
    private var easeBannerShown = false
    private var profileApplyInFlight = false
    /// ws `simulate_capture_pressure`: replaces the policy's inputs field by field (kept until
    /// `{reset: true}` or a relaunch, so a start under simulated pressure can be tested too).
    private var simulatedPressure: CaptureEasePolicy.Inputs?
    private var simulatedFast = false
    /// Main queue: the first step down of a recording (the one banner, autoHide 6 s).
    var onCaptureEased: (() -> Void)?

    private var uptime: Double { ProcessInfo.processInfo.systemUptime }

    /// Seconds this recording has wanted an eased capture so far.
    var easedSeconds: Int { Int(easedAccum + (easedSince.map { Date().timeIntervalSince($0) } ?? 0)) }

    private func setProfile(_ p: CaptureLoad) {
        let now = Date()
        if let s = easedSince { easedAccum += now.timeIntervalSince(s); easedSince = nil }
        currentProfile = p
        if p != .normal { easedSince = now }
    }

    /// Readings for a notification tick and the start decision: thermal + Low Power right now,
    /// memory pressure and GPU from the latest sample.
    private func liveInputs() -> CaptureEasePolicy.Inputs {
        var i = CaptureEasePolicy.Inputs(sample: ResourceSampler.shared.latest ?? [:])
        i.thermal = ResourceSampler.thermalName(ProcessInfo.processInfo.thermalState)
        i.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        return i
    }

    private func withSimulation(_ base: CaptureEasePolicy.Inputs) -> CaptureEasePolicy.Inputs {
        simulatedPressure.map { base.overridden(by: $0) } ?? base
    }

    /// New recording (from `start`, state .starting): reset, and START eased when the Mac is
    /// already under pressure (or the mode says so) — the first stream is created eased, no
    /// live change needed.
    private func resetCaptureProfile() {
        easedAccum = 0; easedSince = nil; profileChanges = 0; easeBannerShown = false
        streamProfile = nil; profileApplyInFlight = false
        easePolicy.config = simulatedFast ? .fast : CaptureEasePolicy.Config()
        let inputs = withSimulation(liveInputs())
        let p = easePolicy.begin(at: uptime, mode: captureProfileMode, inputs: inputs)
        setProfile(p)
        guard p != .normal else { return }
        let reason = captureProfileMode == .eased ? "mode_eased" : "start: " + CaptureEasePolicy.instantTriggers(inputs).joined(separator: "+")
        logProfileEvent(from: .normal, to: p, reason: reason, values: inputs, how: "start", applied: true, extra: ["at_start": true])
    }

    /// The sampler's 10 s recording sample (main queue).
    func capturePressureSample(_ s: [String: Any]) {
        guard state == .recording else { return }
        feedEasePolicy(withSimulation(CaptureEasePolicy.Inputs(sample: s)), isSample: true)
    }

    /// Thermal state / Low Power Mode changed (main queue): judge at once, no GPU counting.
    func capturePressureNudge(_ why: String) {
        guard state == .recording else { return }
        feedEasePolicy(withSimulation(liveInputs()), isSample: false)
    }

    private func feedEasePolicy(_ inputs: CaptureEasePolicy.Inputs, isSample: Bool) {
        guard let d = easePolicy.tick(.init(now: uptime, inputs: inputs, isSample: isSample)) else { return }
        Task { @MainActor in await self.applyDecision(d, how: "policy") }
    }

    /// Settings ▸ Capture / ws: takes effect on the running recording at once.
    func setCaptureProfileMode(_ m: CaptureProfileMode) {
        captureProfileMode = m
        guard state == .recording || state == .starting, let d = easePolicy.setMode(m, now: uptime) else { return }
        Task { @MainActor in await self.applyDecision(d, how: "mode") }
    }

    @MainActor
    private func applyDecision(_ d: CaptureEasePolicy.Decision, how: String) async {
        guard state == .recording || state == .starting else { return }
        let from = currentProfile
        setProfile(d.to)
        let outcome = await applyCaptureProfile(reason: d.reason)
        var extra: [String: Any] = [:]
        switch outcome {
        case .applied: break
        case .deferred(let why): extra["deferred"] = why
        case .failed(let err):
            // Keep the old profile; NEVER roll a part over this.
            extra["error"] = err
            setProfile(from)
            easePolicy.applyFailed(d, now: uptime)
        }
        if case .failed = outcome {} else { profileChanges += 1 }
        logProfileEvent(from: d.from, to: d.to, reason: d.reason, values: d.values, how: how,
                        applied: { if case .applied = outcome { return true }; return false }(), extra: extra)
        // The one banner of the recording: the first step down the live stream really took (not
        // a menu choice the person just made, not an audio-only part with nothing to ease).
        if d.to > d.from, how != "mode", !easeBannerShown, { if case .applied = outcome { return true }; return false }() {
            easeBannerShown = true
            onCaptureEased?()
        }
    }

    enum ProfileApply { case applied, deferred(String), failed(String) }

    /// Put the live video stream on `currentProfile` with `updateConfiguration` (a FULL
    /// configuration at the part's pinned size). Without a live video stream the profile is
    /// only remembered: the next stream (a roll, a fallback) is created with it. Updates are
    /// serialised: one in flight carries on to whatever `currentProfile` is when it finishes.
    @MainActor @discardableResult
    func applyCaptureProfile(reason: String) async -> ProfileApply {
        guard !profileApplyInFlight else { return .deferred("follows the update already in flight") }
        profileApplyInFlight = true
        defer { profileApplyInFlight = false }
        var result: ProfileApply = .applied
        while true {
            let target = currentProfile
            guard state == .recording else { return .deferred("not recording yet — the first stream starts with it") }
            guard currentSource?.isAudioOnly != true else { return .deferred("audio-only part — the next video part starts with it") }
            guard !rolling else { return .deferred("a part roll is in flight — applied when it ends") }
            guard !videoStopped, let stream = videoStream, let size = pinnedSize else {
                return .deferred("no live video stream — the next part starts with it")
            }
            if streamProfile == target { return result }
            let vp = Self.videoProfile(for: target)
            let t0 = Date()
            do {
                try await stream.updateConfiguration(Self.videoConfig(size: size, profile: target))
                guard stream === videoStream else { return .deferred("the stream was replaced during the update") }
                streamProfile = target
                result = .applied
                rlog("capture: stream → \(target.rawValue) (\(vp.fps) fps \(vp.pixelFormatName), cursor \(vp.showsCursor ? "on" : "off"), queue \(vp.queueDepth)) in \(Int(Date().timeIntervalSince(t0) * 1000)) ms — \(reason)")
            } catch {
                rlog("capture: updateConfiguration → \(target.rawValue) FAILED (\(error.localizedDescription)) — keeping \(streamProfile?.rawValue ?? "?")")
                return .failed(error.localizedDescription)
            }
        }
    }

    private func logProfileEvent(from: CaptureLoad, to: CaptureLoad, reason: String, values: CaptureEasePolicy.Inputs,
                                 how: String, applied: Bool, extra: [String: Any] = [:]) {
        let vp = Self.videoProfile(for: to)
        var e: [String: Any] = [
            "recording_id": recordingId ?? "", "from": from.rawValue, "to": to.rawValue, "reason": reason,
            "values": values.json, "mode": captureProfileMode.rawValue, "how": how,
            "at_s": Int(Date().timeIntervalSince(startedAt ?? Date())), "applied": applied,
            "simulated": simulatedPressure != nil,
            "stream": ["fps": vp.fps, "pixel_format": vp.pixelFormatName, "cursor": vp.showsCursor, "queue_depth": vp.queueDepth] as [String: Any],
            "segment": segmentIndex,
        ]
        if simulatedFast { e["fast"] = true }
        for (k, v) in extra { e[k] = v }
        EventLog.shared.log("capture_profile", e,
                            summary: "capture: \(from.rawValue) → \(to.rawValue) (\(reason), \(how))\(applied ? "" : " — not applied live: \((extra["error"] ?? extra["deferred"]) ?? "?")")\(simulatedPressure != nil ? " [simulated]" : "")")
    }

    /// For `status.capture_profile`.
    func captureProfileJSON() -> [String: Any] {
        var d: [String: Any] = ["mode": captureProfileMode.rawValue]
        guard state == .recording || state == .starting else { return d }
        let vp = Self.videoProfile(for: currentProfile)
        d["current"] = currentProfile.rawValue
        d["stream"] = streamProfile?.rawValue ?? NSNull()
        d["fps"] = vp.fps
        d["pixel_format"] = vp.pixelFormatName
        d["eased_seconds"] = easedSeconds
        d["changes"] = profileChanges
        d["gpu_high_streak"] = easePolicy.gpuHighStreak
        d["inputs"] = easePolicy.lastInputs.json
        d["simulated"] = simulatedPressure?.json ?? NSNull()
        d["fast"] = simulatedFast
        return d
    }

    /// ws `simulate_capture_pressure {thermal?, gpu_pct?, low_power?, mem_pressure?, clear?, fast?, reset?}`.
    /// Overrides the policy's INPUTS (real readings fill the fields not given); `clear` = all
    /// clear; `fast` = 2 GPU samples / 20 s clear / 5 s dwell; `reset` = real readings and the
    /// real windows again. Judged at once (a notification tick — GPU runs still need samples).
    func simulateCapturePressure(_ obj: [String: Any]) -> String {
        if (obj["reset"] as? Bool) == true {
            simulatedPressure = nil; simulatedFast = false
            easePolicy.config = CaptureEasePolicy.Config()
            EventLog.shared.log("test_simulate_capture_pressure", ["recording_id": recordingId ?? NSNull(), "reset": true])
            return "capture pressure simulation off"
        }
        var o = simulatedPressure ?? CaptureEasePolicy.Inputs()
        if (obj["clear"] as? Bool) == true { o = .clear }
        if let t = obj["thermal"] as? String { o.thermal = t }
        if let g = (obj["gpu_pct"] as? Double) ?? (obj["gpu_pct"] as? Int).map(Double.init) { o.gpuPct = g }
        if let l = obj["low_power"] as? Bool { o.lowPower = l }
        if let m = obj["mem_pressure"] as? String { o.memPressure = m }
        simulatedPressure = o
        if (obj["fast"] as? Bool) == true { simulatedFast = true; easePolicy.config = .fast }
        rlog("TEST — simulate_capture_pressure \(o.json)\(simulatedFast ? " (fast windows)" : "")")
        EventLog.shared.log("test_simulate_capture_pressure", ["recording_id": recordingId ?? NSNull(), "inputs": o.json, "fast": simulatedFast])
        capturePressureNudge("simulate")
        return "simulated capture pressure: \(o.json.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " "))\(state == .recording ? "" : " (applies from the next recording)")"
    }

    /// ws `force_capture_profile {profile: "normal"|"eased"}` — exercises `applyCaptureProfile`
    /// directly; the policy carries on from the forced level.
    func forceCaptureProfile(_ name: String) -> String {
        guard state == .recording else { return "not recording" }
        guard let p = CaptureLoad(rawValue: name), p != .audioOnly else { return "unknown profile \(name) (normal | eased)" }
        guard let d = easePolicy.force(p, now: uptime) else { return "already \(p.rawValue)" }
        Task { @MainActor in await self.applyDecision(d, how: "forced") }
        return "forcing \(p.rawValue)"
    }

    // MARK: window-gone hold

    private func beginWindowGoneHold(reason: String) {
        guard state == .recording, holdTimer == nil else { return }
        if callOver {
            if !loggedGoneAfterEnd {
                loggedGoneAfterEnd = true
                rlog("record: window gone (\(reason)) after call end — no fallback, waiting for stop")
            }
            return
        }
        holdReason = reason
        EventLog.shared.log("window_gone_hold", [
            "recording_id": recordingId ?? "", "reason": reason, "seconds": Self.WINDOW_GONE_HOLD,
            "video_stopped": videoStopped,
        ], summary: "record: recorded window gone (\(reason)) — holding \(Int(Self.WINDOW_GONE_HOLD)) s for a call end before falling back")
        holdTimer = Timer.scheduledTimer(withTimeInterval: Self.WINDOW_GONE_HOLD, repeats: false) { [weak self] _ in
            self?.holdElapsed()
        }
        holdTimer?.tolerance = 0.2
    }

    /// The call this recording belongs to has ended (main.swift, before the grace logic).
    /// Cancels a pending window-gone hold so no display fallback can follow a call end.
    func noteCallEnded() {
        guard state == .recording || state == .starting else { return }
        callOver = true
        if pendingVideoFailure { pendingVideoFailure = false }   // benign: the window went with the call
        if holdTimer != nil {
            holdTimer?.invalidate(); holdTimer = nil
            EventLog.shared.log("window_gone_held", [
                "recording_id": recordingId ?? "", "outcome": "call_ended", "reason": holdReason,
            ], summary: "record: window gone and the call ended — no fallback, ending normally")
        }
    }

    private func holdElapsed() {
        holdTimer = nil
        guard state == .recording, !callOver else { return }
        // The window is gone but the call is still live (a popped-out window was closed, the
        // app re-created its window, …): today's fallback — the call window if there is a new
        // one, else the display the old one was on. THIS is a real stream failure.
        streamFailure = true
        pendingVideoFailure = false
        errorRolls += 1
        guard errorRolls <= 3 else {
            onError?("Recording interrupted: the window we were recording went away repeatedly.")
            stop(reason: "window gone repeatedly")
            return
        }
        var target: Source
        let fallbackPick = call.flatMap { $0.pid > 0 ? WindowPicker.pick(kind: $0.kind, pid: $0.pid) : nil }
        if let w = fallbackPick?.window, case .window(let oldId, _)? = currentSource, w.id != oldId {
            target = .window(w.id, w.title)
        } else if !videoByDefault {
            // 0.3.15: this recording had video only because the person picked a source, and
            // that source is gone. Falling back to a display would capture a screen nobody
            // asked for — go back to audio instead.
            target = .audio
        } else {
            let display = lastWindowFrame.map { WindowPicker.display(containing: $0) }
                ?? call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID()
            target = .display(display)
        }
        if let fallbackPick {
            let rule: String? = target.isAudioOnly ? "fallback_audio" : { if case .display = target { return "fallback_display" }; return nil }()
            var chosen: WindowCandidate?
            if case .window(let wid, _) = target { chosen = fallbackPick.screen.first { $0.id == wid } }
            WindowPicker.logPick(how: "fallback", call: call, pick: fallbackPick, recordingId: recordingId, detail: holdReason,
                                 picked: .some(chosen), rule: rule)
            lastPickSignature = fallbackPick.signature
        }
        EventLog.shared.log("window_gone_held", [
            "recording_id": recordingId ?? "", "outcome": "fallback", "reason": holdReason,
            "target": target.json, "attempt": errorRolls,
        ], summary: "record: window gone and the call is still live — falling back to \(target.label)")
        onError?(target.isAudioOnly
                 ? "The window you picked went away — back to audio only."
                 : "The window we were recording went away — recording \(target.label) instead.")
        rollSegment(to: target, reason: "window gone, call still live (\(holdReason))")
    }

    // MARK: stop

    /// Idempotent. The 0.1.x double-stop ("Failed to stop a stream that is already stopped")
    /// came from the stream-error path calling back into stop while stop was already running;
    /// `state` and `videoStopped` are the guards.
    ///
    /// The teardown (stopCapture ×2, writer finish) runs on a DETACHED task, never on the main
    /// actor: applicationWillTerminate blocks the main thread waiting for it (0.2.3), and a
    /// main-actor task can never run while the main thread is blocked. `onFinalised` fires
    /// from that task the moment the file is complete; `onStopped` follows on the main queue.
    func stop(reason: String, onFinalised: (() -> Void)? = nil) {
        if state == .starting {
            cancelStart(reason: reason)
            onFinalised?()
            return
        }
        guard state == .recording else {
            rlog("record: stop ignored (state=\(state.rawValue), reason=\(reason))")
            return
        }
        state = .stopping
        resolveTimer?.invalidate(); resolveTimer = nil
        holdTimer?.invalidate(); holdTimer = nil
        healthTimer?.invalidate(); healthTimer = nil
        let endHealth = flags
        let endLine = (currentSource?.isAudioOnly == true ? "" : "video \(flags["video"].map { $0 ? "✓" : "✗" } ?? "–") · ")
            + "mic \(flags["mic"].map { $0 ? "✓" : "✗" } ?? "–") · system \(flags["system"].map { $0 ? "✓" : "✗" } ?? "–")"
        let unwell = endHealth.values.contains(false) || streamFailure || systemStreamFailed != nil
        let sysSnap = options.systemAudio ? systemMeter.snapshot() : nil
        let micSnap = micMeter?.snapshot()
        let sysStreamAlive = audioStream != nil
        let id = recordingId ?? ""
        let started = startedAt ?? Date()
        let lastIndex = segmentIndex
        let lastStart = segmentStart
        let w = currentWriter()
        let vStream = videoStream
        let aStream = audioStream
        let wasStopped = videoStopped
        videoStream = nil
        audioStream = nil
        setWriter(nil)
        mic?.onBuffer = nil
        audioForwarder.sink = nil
        // 0.3.20: the last part's mic gap fills + overloads, read while `mic` still exists;
        // and the sampler's summary, on THIS (main) queue — calling it from the detached task
        // below raced `tick` appending samples on main.
        let lastCounters = takeSegmentCounters()
        // 0.3.21: how much of this recording was eased, read on main before the detach.
        let easedSecs = easedSeconds
        let profileChangeCount = profileChanges
        let profileAtEnd = currentProfile
        streamProfile = nil
        overloads.detach()
        let resources = ResourceSampler.shared.endRecording()
        mic?.stop()
        let micBuffers = mic?.buffersSeen ?? 0
        let micPeak = mic?.peak ?? 0
        // Read off the object while it still exists: `mic` is nil one line down, so the
        // conditioner / format fields in `recording_stopped` had been null since 0.3.2.
        let micConditioner = mic?.conditioner.snapshot
        let micProcessingJSON = mic?.voiceProcessingJSON
        let micDevice = mic?.deviceJSON
        let micFormat = micFormatLabel
        let micHardware = micHardwareLabel ?? mic?.hardwareFormatLabel
        mic = nil
        micActive = false

        willStopOwnStreams?((wasStopped ? 0 : 1) + (aStream != nil ? 1 : 0))
        Task.detached { [self] in
            if let vStream, !wasStopped { try? await vStream.stopCapture() }
            if let aStream { try? await aStream.stopCapture() }
            if let w {
                await w.finish()
                self.videoFramesTotal += w.videoFrames; self.videoDupTotal += w.duplicatedFrames
                self.closeSegment(index: lastIndex, writer: w, started: lastStart, recordingId: id,
                                  counters: lastCounters, reason: "stop: \(reason)")
            }
            let secs = Int(Date().timeIntervalSince(started))
            let files = self.segments.compactMap { $0["path"] as? String }
            let bytes = self.segments.reduce(0) { $0 + (($1["bytes"] as? Int) ?? 0) }
            Registry.shared.update(id, [
                "status": "local",
                "mix_first": self.mixFirstOK,
                "audio_tracks": self.audioTrackCount,
                "ended_at": isoNow(),
                "duration": secs,
                "bytes": bytes,
                "files": files,
                "segments": self.segments,
                "shares": self.shares,
                "needs_sync": true,
            ])
            self.api?.syncRecording(id)
            EventLog.shared.log("recording_stopped", [
                "recording_id": id, "reason": reason, "seconds": secs, "bytes": bytes,
                "segments": self.segments.count, "files": files,
                "mic_buffers": micBuffers, "mic_peak": Double(micPeak),
                "mic_peak_db": micSnap?["peak_db"] ?? NSNull(), "mic_audible_s": micSnap?["audible_s"] ?? NSNull(),
                "mic_conditioner": micConditioner ?? NSNull(),
                "mic_processing": micProcessingJSON ?? NSNull(),
                "mic_processing_requested": self.options.mic ? self.micVoiceProcessing : NSNull(),
                "mic_format": micFormat ?? NSNull(),
                "mic_hw_format": micHardware ?? NSNull(),
                "mic_device": micDevice ?? NSNull(),           // 0.3.16: device + restarts
                "system_buffers": sysSnap?["buffers"] ?? NSNull(), "system_peak_db": sysSnap?["peak_db"] ?? NSNull(),
                "system_audible_s": sysSnap?["audible_s"] ?? NSNull(), "system_stream": self.options.systemAudio ? sysStreamAlive : NSNull(),
                "system_error": self.systemStreamFailed ?? NSNull(),
                "video_frames": self.videoFramesTotal, "video_dup": self.videoDupTotal,
                "health": endHealth, "health_line": endLine, "stream_failure": self.streamFailure,
                "source_mode": self.sourceMode, "resources": resources,
                // 0.3.21: capture profile
                "eased_seconds": easedSecs, "profile_changes": profileChangeCount,
                "capture_profile_end": profileAtEnd.rawValue, "capture_profile_mode": self.captureProfileMode.rawValue,
            ], summary: "record: stopped \(id) (\(reason)) — \(self.segments.count) segment(s), \(secs)s, \(bytes) bytes, mic buffers \(micBuffers), \(endLine), video frames \(self.videoFramesTotal)")
            // 0.3.20: tray.log names windows and apps — full telemetry only, checked before reading.
            if unwell, Telemetry.allows(.logExcerpt) {
                let lines = LogTail.excerpt()
                EventLog.shared.log("log_excerpt", ["recording_id": id, "lines": lines, "why": endLine],
                                    summary: "record: shipping \(lines.count) tray.log lines — recording ended with \(endLine)\(self.streamFailure ? " and a stream failure" : "")")
            }
            let saved: [String: Any] = [
                "recording_id": id,
                "path": files.first as Any,
                "files": files,
                "seconds": secs,
                "bytes": bytes,
                "segments": self.segments.count,
                "call": self.call?.json as Any,
                "upload": self.options.upload,
            ]
            onFinalised?()
            DispatchQueue.main.async {
                self.state = .idle
                self.call = nil
                self.currentSource = nil
                self.onStopped?(saved)
            }
        }
    }
}

/// Stable output object for the system-audio stream: it survives segment rolls, so audio
/// never has to be re-plumbed mid-recording — it just follows `sink` to the current writer.
final class AudioForwarder: NSObject, SCStreamOutput, SCStreamDelegate {
    let queue = DispatchQueue(label: "recorder.system-audio")
    var sink: ((CMSampleBuffer) -> Void)?
    /// 0.3.17: zero every buffer before the meter and the sink — see `MicCapture.muted`.
    var muted = false
    private var silenceFailed = 0

    /// Overwrite the sample data with zeros, in place. SCK hands us the buffer to consume;
    /// the writer and the live mix are its only readers after this.
    static func silence(_ sb: CMSampleBuffer) -> Bool {
        guard let bb = CMSampleBufferGetDataBuffer(sb) else { return false }
        let n = CMBlockBufferGetDataLength(bb)
        guard n > 0 else { return true }
        return CMBlockBufferFillDataBytes(with: 0, blockBuffer: bb, offsetIntoDestination: 0, dataLength: n) == noErr
    }
    /// Main-queue-agnostic; the controller hops to main.
    var onStopped: ((Error) -> Void)?
    private(set) var meter = LevelMeter()
    var streamStartedAt: Date?
    private var buffers = 0
    private var unmeasured = 0

    /// New meter per recording (the forwarder itself survives across recordings).
    func reset() { meter = LevelMeter(); buffers = 0; unmeasured = 0; streamStartedAt = nil }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        buffers += 1
        if muted, !Self.silence(sb) {
            silenceFailed += 1
            if silenceFailed == 1 { rlog("record: could not silence a system audio buffer — dropping it instead while muted") }
            return
        }
        if let m = LevelMeter.measure(sb) {
            meter.note(peak: m.peak, rms: m.rms)
        } else {
            unmeasured += 1
            if unmeasured == 1 { rlog("record: system audio buffer is not Float32 PCM — level meter off (buffers still counted)") }
        }
        if buffers == 1 {
            let asbd = CMSampleBufferGetFormatDescription(sb).flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            rlog("record: first system audio buffer \(streamStartedAt.map { "\(Int(Date().timeIntervalSince($0) * 1000)) ms after start" } ?? "") — \(asbd.map { "\(Int($0.mSampleRate)) Hz × \($0.mChannelsPerFrame) ch, \($0.mBitsPerChannel)-bit\($0.mFormatFlags & kAudioFormatFlagIsFloat != 0 ? " float" : "")\($0.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0 ? " non-interleaved" : "")" } ?? "?"), \(CMSampleBufferGetNumSamples(sb)) frames, peak \(String(format: "%.1f", meter.peakDb)) dB")
        }
        sink?(sb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        rlog("record: system-audio stream stopped: \(error.localizedDescription)")
        onStopped?(error)
    }
}
