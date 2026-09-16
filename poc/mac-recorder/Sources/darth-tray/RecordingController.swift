import AppKit
import AVFoundation
import ScreenCaptureKit
import RecorderCore

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

        var label: String {
            switch self {
            case .window(let id, let title): return "window #\(id) \"\(title)\""
            case .display(let id): return "display \(id)"
            }
        }
        var json: [String: Any] {
            switch self {
            case .window(let id, let title): return ["kind": "window", "window_id": Int(id), "title": title]
            case .display(let id): return ["kind": "display", "display_id": Int(id)]
            }
        }
    }

    /// What the user asked for (0.2.4 Record… dialog / ws `start` fields). The defaults are
    /// exactly the 0.2.3 behaviour: auto-picked source, both audio tracks, upload when signed in.
    struct RecordOptions {
        /// nil = auto: the call window when there is a call, else the main display.
        var source: Source? = nil
        var systemAudio = true
        var mic = true
        /// false = keep the file on this Mac: no automatic upload (the PWA / menu can still push it).
        var upload = true

        var json: [String: Any] {
            ["source": source?.json ?? "auto", "system_audio": systemAudio, "mic": mic, "upload": upload]
        }
        var summary: String {
            "audio=\(systemAudio ? "system" : "-")\(mic ? "+mic" : "") upload=\(upload)"
        }
    }

    private(set) var state: State = .idle
    private(set) var recordingId: String?
    private(set) var options = RecordOptions()

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
    private(set) var micActive = false
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
    private var flags: [String: Bool] = [:]   // track → ok, transitions drive events/callback
    private var healthTicks = 0
    private var micDenied = false

    var systemMeter: LevelMeter { audioForwarder.meter }
    var micMeter: LevelMeter? { mic?.meter }

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
        h.videoOK = !videoStopped && Date().timeIntervalSince(lastVideoAt) < Self.VIDEO_STALL_S
        if options.systemAudio {
            if audioStream == nil { h.systemOK = false }
            else if call != nil && !callOver { h.systemOK = systemMeter.secondsSinceAudible < Self.SYSTEM_SILENT_S }
            else { h.systemOK = true }
        }
        if options.mic {
            if let m = mic { h.micOK = m.meter.secondsSinceAudible < Self.MIC_SILENT_S } else { h.micOK = false }
        }
        return h
    }

    /// "video ✓ · mic ✓ · system ✗" — the banner sub line and the menu.
    func healthLine() -> String {
        let h = health()
        var parts: [String] = []
        func tick(_ ok: Bool?) -> String { ok == nil ? "–" : (ok! ? "✓" : "✗") }
        parts.append("video \(tick(h.videoOK))")
        if options.mic { parts.append("mic \(tick(h.micOK))") }
        if options.systemAudio {
            // Quiet system audio outside a call is neutral, not a fault.
            let quiet = audioStream != nil && !(call != nil && !callOver) && !systemMeter.audible
            parts.append(quiet ? "system ·" : "system \(tick(h.systemOK))")
        }
        return parts.joined(separator: " · ")
    }

    private func healthDetail() -> String {
        var s = "video frames=\(videoFramesTotal + (currentWriter()?.videoFrames ?? 0)) stall=\(Int(Date().timeIntervalSince(lastVideoAt)))s"
        if options.systemAudio { s += " · system \(audioStream == nil ? "NO STREAM" : String(format: "%.0f dB", systemMeter.levelDb)) silent=\(Int(systemMeter.secondsSinceAudible))s bufs=\(systemMeter.buffers)" }
        if options.mic { s += " · mic \(mic == nil ? "NONE" : String(format: "%.0f dB", micMeter!.levelDb)) silent=\(Int(micMeter?.secondsSinceAudible ?? 0))s bufs=\(micMeter?.buffers ?? 0)" }
        return s
    }

    /// For the ws status payload: `audio: {system:{…}, mic:{…}, video:{…}}`.
    func healthJSON() -> [String: Any] {
        let h = health()
        var d: [String: Any] = [
            "video": ["ok": h.videoOK ?? NSNull(), "frames": videoFramesTotal + (currentWriter()?.videoFrames ?? 0),
                      "silent_s": Int(Date().timeIntervalSince(lastVideoAt)), "stream_alive": !videoStopped] as [String: Any],
            "line": healthLine(),
        ]
        if options.systemAudio {
            var s = systemMeter.snapshot(); s["ok"] = h.systemOK ?? NSNull(); s["stream_alive"] = audioStream != nil
            if let e = systemStreamFailed { s["error"] = e }
            d["system"] = s
        }
        if options.mic {
            var m = micMeter?.snapshot() ?? ["level_db": -120, "audible": false, "silent_s": 0, "audible_s": 0, "buffers": 0]
            m["ok"] = h.micOK ?? NSNull(); m["stream_alive"] = mic != nil
            d["mic"] = m
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
        videoFramesTotal = 0; videoDupTotal = 0; lastVideoCount = -1; lastVideoWriter = nil
        audioForwarder.reset()
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH.mm.ss"
        base = "\(f.string(from: now)) \(call?.kind.rawValue ?? "display")"
        let folder = Paths.recordings.appendingPathComponent(id, isDirectory: true)
        dir = folder
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        // Where to point the camera.
        var source: Source
        if let chosen = options.source {
            source = chosen
        } else if let call, call.pid > 0 {
            let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
            WindowPicker.logCandidates(phase: "record", call: call, pick: pick)
            if let w = pick.window {
                source = .window(w.id, w.title)
            } else {
                source = .display(call.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID())
                rlog("record: no call window found — falling back to \(source.label)")
            }
        } else {
            source = .display(call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID())
        }

        EventLog.shared.log("recording_starting", [
            "recording_id": id, "source": source.json, "call": call?.json ?? NSNull(), "dir": folder.path,
            "options": options.json,
        ], summary: "record: starting \(id) on \(source.label) (\(options.summary))")

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
                    Registry.shared.update(id, ["status": "upload_failed", "error": "capture failed: \(error.localizedDescription)"])
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
                let m = MicCapture()
                do {
                    try m.start()
                    micFormat = m.format
                    self.mic = m
                    self.micActive = true
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
        let (filter, displayID) = try await timed("shareable content + filter for \(source.label)", deadline: deadline) { try await Self.filter(for: source) }
        try Task.checkCancellation()
        let t0 = Date()
        let (w, h) = CaptureSession.pixelSize(of: filter)
        rlog("record: pixel size \(w)x\(h) took \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
        pinnedSize = (w, h)

        let tracks = audioTracks(micFormat: micFormat)
        let url = segmentURL(1)
        let rec = try Recorder(url: url, width: w, height: h, fps: fps, audioTracks: tracks)
        rec.onStop = { [weak self] err in
            DispatchQueue.main.async { self?.videoStreamFailed(err) }
        }
        rec.onWriterFailure = { [weak self] err in self?.writerFailed(err) }
        setWriter(rec)
        segmentIndex = 1
        segmentStart = Date()
        currentSource = source

        videoStream = try await timed("video stream start on \(source.label)", deadline: deadline,
                                      orphan: { s in Task { try? await s.stopCapture() } }) {
            try await Self.startVideoStream(filter: filter, fps: self.fps, output: rec, size: (w, h))
        }
        try Task.checkCancellation()
        videoStopped = false
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
        errorRolls = 0
        lastVideoAt = Date()
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.healthTick() }
        healthTimer?.tolerance = 0.2
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
            "system_stream": options.systemAudio ? (audioStream != nil) : NSNull(),
            "system_error": systemStreamFailed ?? NSNull(),
            "mic_stream": options.mic ? (mic != nil) : NSNull(),
            "mic_denied": micDenied,
            "audio_display_id": Int(displayID),
            "path": url.path, "options": options.json,
        ], summary: "record: \(recordingId ?? "") \(w)x\(h) tracks=[\(tracks.map { $0.name }.joined(separator: ","))] started=[\(started.joined(separator: ","))] \(options.summary) → \(url.lastPathComponent)")
        onStarted?()
        startResolveTimer()
    }

    // MARK: sources

    private func segmentURL(_ index: Int) -> URL {
        (dir ?? Paths.recordings).appendingPathComponent("\(base) part\(index).mp4")
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

    private static func startVideoStream(filter: SCContentFilter, fps: Int, output: Recorder, size: (w: Int, h: Int)? = nil) async throws -> SCStream {
        let (w, h) = size ?? CaptureSession.pixelSize(of: filter)
        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.scalesToFit = true      // letterbox a differently-shaped source into the pinned size
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true
        cfg.queueDepth = 6
        cfg.capturesAudio = false
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
                let (filter, _) = try await Self.filter(for: source)
                let (w, h) = self.pinnedSize ?? CaptureSession.pixelSize(of: filter)
                let tracks = self.audioTracks(micFormat: self.mic?.format)
                let index = oldIndex + 1
                let url = self.segmentURL(index)
                let rec = try Recorder(url: url, width: w, height: h, fps: self.fps, audioTracks: tracks)
                rec.onStop = { [weak self] err in
                    DispatchQueue.main.async { self?.videoStreamFailed(err) }
                }
                rec.onWriterFailure = { [weak self] err in self?.writerFailed(err) }
                let newStream = try await Self.startVideoStream(filter: filter, fps: self.fps, output: rec, size: (w, h))
                // Swap: audio + mic follow the current writer, so this is the cut point.
                self.setWriter(rec)
                self.segmentIndex = index
                self.segmentStart = Date()
                self.currentSource = source
                self.videoStream = newStream
                self.segments.append([
                    "index": index, "path": url.path, "source": source.json,
                    "started_at": isoString(self.segmentStart), "bytes": 0, "seconds": 0,
                ])
                // Retire the old one — but never call stopCapture on a stream the system
                // already tore down (that is what logged "Failed to stop a stream that is
                // already stopped" in 0.1.x).
                if !oldDead {
                    self.willStopOwnStreams?(1)
                    if let oldStream { try? await oldStream.stopCapture() }
                }
                self.videoStopped = false
                if let old {
                    await old.finish()
                    self.videoFramesTotal += old.videoFrames; self.videoDupTotal += old.duplicatedFrames
                    self.closeSegment(index: oldIndex, url: old.url, started: oldStart, stats: old.stats)
                }
                self.persist(status: "recording")
                EventLog.shared.log("segment_started", [
                    "recording_id": self.recordingId ?? "", "segment": index, "reason": reason,
                    "source": source.json, "path": url.path, "width": w, "height": h,
                ], summary: "record: segment \(index) (\(reason)) → \(source.label)")
                self.onSegment?(index, reason)
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
            "files": files,
            "segments": segments,
            "bytes": bytes,
            "duration": Int(Date().timeIntervalSince(startedAt ?? Date())),
            "shares": shares,
            "needs_sync": true,
        ])
        api?.syncRecording(id)
    }

    private func closeSegment(index: Int, url: URL, started: Date, stats: String) {
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        let secs = Int(Date().timeIntervalSince(started))
        if let i = segments.firstIndex(where: { ($0["index"] as? Int) == index }) {
            segments[i]["bytes"] = bytes
            segments[i]["seconds"] = secs
            segments[i]["ended_at"] = isoNow()
        }
        rlog("record: segment \(index) closed — \(stats) bytes=\(bytes) \(secs)s → \(url.lastPathComponent)")
    }

    /// The video stream died — the recorded window was closed, the app quit, or the system
    /// tore the stream down. The plan says: fall back to the display that contained it and log
    /// it. Only give up after three of these.
    private func videoStreamFailed(_ err: Error) {
        guard state == .recording else { return }
        videoStopped = true
        streamFailure = true
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
        guard related(share) else {
            rlog("record: share by \(share.appBundle) is not this call's app (\(call?.bundleId ?? "-")) — video source unchanged")
            return
        }
        var source: Source?
        if let wid = share.windowID { source = .window(wid, share.windowTitle ?? "") }
        else if let did = share.displayID { source = .display(did) }
        guard let source else { return }
        rollSegment(to: source, reason: "share started (\(share.appName ?? share.appBundle))")
    }

    func shareEnded(_ share: ShareInfo) {
        guard state == .recording else { return }
        if let i = shares.firstIndex(where: { ($0["id"] as? String) == share.id }) {
            shares[i]["ended_at"] = isoNow()
        }
        guard related(share) else { return }
        // Back to the call window (re-resolved: it may have moved while the share was up).
        guard let call, call.pid > 0 else {
            if let f = call?.windowFrame { rollSegment(to: .display(WindowPicker.display(containing: f)), reason: "share ended") }
            return
        }
        let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
        WindowPicker.logCandidates(phase: "share-ended", call: call, pick: pick)
        if let w = pick.window {
            rollSegment(to: .window(w.id, w.title), reason: "share ended")
        } else {
            rollSegment(to: .display(CGMainDisplayID()), reason: "share ended, no call window")
        }
    }

    // MARK: liveness

    private func startResolveTimer() {
        resolveTimer?.invalidate()
        resolveTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.reresolve() }
        resolveTimer?.tolerance = 1
    }

    /// Every 5 s while recording: log the candidate list again (field data) and make sure the
    /// window we are pointed at still exists.
    private func reresolve() {
        guard state == .recording, let call, call.pid > 0 else { return }
        let pick = WindowPicker.pick(kind: call.kind, pid: call.pid)
        WindowPicker.logCandidates(phase: "reresolve", call: call, pick: pick)
        guard case .window(let id, _)? = currentSource else { return }
        if let f = ShareDetector.windowFrame(id) { lastWindowFrame = f }
        if ShareDetector.windowInfo(id) == nil {
            // The window we were recording is gone — hold, do not fall back yet.
            beginWindowGoneHold(reason: "recorded window disappeared")
        }
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
        // one, else the display the old one was on.
        errorRolls += 1
        guard errorRolls <= 3 else {
            onError?("Recording interrupted: the window we were recording went away repeatedly.")
            stop(reason: "window gone repeatedly")
            return
        }
        var target: Source
        if let call, call.pid > 0, let w = WindowPicker.pick(kind: call.kind, pid: call.pid).window,
           case .window(let oldId, _)? = currentSource, w.id != oldId {
            target = .window(w.id, w.title)
        } else {
            let display = lastWindowFrame.map { WindowPicker.display(containing: $0) }
                ?? call?.windowFrame.map { WindowPicker.display(containing: $0) } ?? CGMainDisplayID()
            target = .display(display)
        }
        EventLog.shared.log("window_gone_held", [
            "recording_id": recordingId ?? "", "outcome": "fallback", "reason": holdReason,
            "target": target.json, "attempt": errorRolls,
        ], summary: "record: window gone and the call is still live — falling back to \(target.label)")
        onError?("The window we were recording went away — recording \(target.label) instead.")
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
        let endLine = "video \(flags["video"].map { $0 ? "✓" : "✗" } ?? "–") · mic \(flags["mic"].map { $0 ? "✓" : "✗" } ?? "–") · system \(flags["system"].map { $0 ? "✓" : "✗" } ?? "–")"
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
        mic?.stop()
        let micBuffers = mic?.buffersSeen ?? 0
        let micPeak = mic?.peak ?? 0
        mic = nil
        micActive = false

        willStopOwnStreams?((wasStopped ? 0 : 1) + (aStream != nil ? 1 : 0))
        Task.detached { [self] in
            if let vStream, !wasStopped { try? await vStream.stopCapture() }
            if let aStream { try? await aStream.stopCapture() }
            if let w {
                await w.finish()
                self.videoFramesTotal += w.videoFrames; self.videoDupTotal += w.duplicatedFrames
                self.closeSegment(index: lastIndex, url: w.url, started: lastStart, stats: w.stats)
            }
            let secs = Int(Date().timeIntervalSince(started))
            let files = self.segments.compactMap { $0["path"] as? String }
            let bytes = self.segments.reduce(0) { $0 + (($1["bytes"] as? Int) ?? 0) }
            Registry.shared.update(id, [
                "status": "local",
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
                "system_buffers": sysSnap?["buffers"] ?? NSNull(), "system_peak_db": sysSnap?["peak_db"] ?? NSNull(),
                "system_audible_s": sysSnap?["audible_s"] ?? NSNull(), "system_stream": self.options.systemAudio ? sysStreamAlive : NSNull(),
                "system_error": self.systemStreamFailed ?? NSNull(),
                "video_frames": self.videoFramesTotal, "video_dup": self.videoDupTotal,
                "health": endHealth, "health_line": endLine, "stream_failure": self.streamFailure,
            ], summary: "record: stopped \(id) (\(reason)) — \(self.segments.count) segment(s), \(secs)s, \(bytes) bytes, mic buffers \(micBuffers), \(endLine), video frames \(self.videoFramesTotal)")
            if unwell {
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
