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

        let begin: (AVAudioFormat?) -> Void = { [weak self] micFormat in
            guard let self else { return }
            Task { @MainActor in
                do {
                    try await self.beginCapture(source: source, micFormat: micFormat)
                } catch {
                    self.mic?.stop(); self.mic = nil; self.micActive = false
                    self.state = .idle
                    Registry.shared.update(id, ["status": "upload_failed", "error": "capture failed: \(error.localizedDescription)"])
                    EventLog.shared.log("recording_failed", ["recording_id": id, "error": error.localizedDescription],
                                        summary: "record: could not start — \(error.localizedDescription)")
                    self.onError?(error.localizedDescription)
                }
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
        let (filter, displayID) = try await Self.filter(for: source)
        let (w, h) = CaptureSession.pixelSize(of: filter)
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

        videoStream = try await Self.startVideoStream(filter: filter, fps: fps, output: rec, size: (w, h))
        videoStopped = false
        if options.systemAudio {
            audioForwarder.sink = { [weak self] sb in self?.currentWriter()?.appendAudio(sb, track: 0) }
            audioStream = try? await Self.startAudioStream(displayID: displayID, output: audioForwarder)
            if audioStream == nil { rlog("record: system-audio stream failed to start — video\(mic == nil ? " only" : " + mic only")") }
        } else {
            audioForwarder.sink = nil
            audioStream = nil
            rlog("record: system audio off by request")
        }
        let micIndex = micTrack
        mic?.onBuffer = { [weak self] sb in self?.currentWriter()?.appendAudio(sb, track: micIndex) }

        state = .recording
        errorRolls = 0
        if case .window(let id, _) = source { lastWindowFrame = ShareDetector.windowFrame(id) }
        segments = [[
            "index": 1, "path": url.path, "source": source.json,
            "started_at": isoString(segmentStart), "bytes": 0, "seconds": 0,
        ]]
        persist(status: "recording")
        EventLog.shared.log("recording_started", [
            "recording_id": recordingId ?? "", "source": source.json, "width": w, "height": h,
            "tracks": tracks.map { $0.name }, "path": url.path, "options": options.json,
        ], summary: "record: \(recordingId ?? "") \(w)x\(h) tracks=[\(tracks.map { $0.name }.joined(separator: ","))] \(options.summary) → \(url.lastPathComponent)")
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
            return (SCContentFilter(display: d, excludingWindows: []), d.displayID)
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
        try await s.startCapture()
        rlog("record: system audio stream on display \(d.displayID)")
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
        EventLog.shared.log("video_stream_error", [
            "recording_id": recordingId ?? "", "error": err.localizedDescription, "call_over": callOver,
        ], summary: "record: video stream died (\(err.localizedDescription))\(callOver ? " after call end — audio continues until stop" : " — holding for a call end")")
        // Audio + mic keep flowing into the current writer; only the video stops. Fall back
        // to another source only if the call turns out to be still live.
        beginWindowGoneHold(reason: err.localizedDescription)
    }

    /// The AVAssetWriter failed: nothing more will be written to this file, so stop instead of
    /// pretending to record (0.2.0 shipped one of these during testing — never again silently).
    private func writerFailed(_ err: Error) {
        guard state == .recording else { return }
        errorRolls += 1
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
        guard state == .recording || state == .starting else {
            rlog("record: stop ignored (state=\(state.rawValue), reason=\(reason))")
            return
        }
        state = .stopping
        resolveTimer?.invalidate(); resolveTimer = nil
        holdTimer?.invalidate(); holdTimer = nil
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
            ], summary: "record: stopped \(id) (\(reason)) — \(self.segments.count) segment(s), \(secs)s, \(bytes) bytes, mic buffers \(micBuffers)")
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

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sb.isValid else { return }
        sink?(sb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        rlog("record: system-audio stream stopped: \(error.localizedDescription)")
    }
}
