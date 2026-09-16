import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

/// One audio track in the output file. Tracks are NEVER mixed at capture: system audio and
/// the microphone are two separate AAC tracks so the transcriber (and a human) can tell the
/// room from the person. `languageCode` is the ISO 639-2 tag written into the track header —
/// it is what ffprobe prints in `Stream #0:N(<lang>)`, so we abuse it as a label that
/// survives every mp4 tool (the QuickTime track-name metadata below is nicer but optional).
public struct AudioTrackSpec {
    public let name: String
    public let languageCode: String
    public let channels: Int
    public let sampleRate: Double
    public init(name: String, languageCode: String, channels: Int = 2, sampleRate: Double = 48_000) {
        self.name = name
        self.languageCode = languageCode
        self.channels = max(1, channels)
        self.sampleRate = sampleRate > 0 ? sampleRate : 48_000
    }
    public static let system = AudioTrackSpec(name: "system", languageCode: "mul")
    public static func mic(channels: Int, sampleRate: Double) -> AudioTrackSpec {
        AudioTrackSpec(name: "mic", languageCode: "eng", channels: channels, sampleRate: sampleRate)
    }
}

/// SCStreamOutput → AVAssetWriter bridge. Video frames go through a pixel-buffer adaptor so
/// that `.idle` frames (SCK sends those at the frame interval when nothing changed) can
/// re-append the previous image and keep the track at a constant fps.
///
/// Audio: zero or more tracks, appended by index. Track 0 is fed by this object's own
/// `SCStreamOutput` callback (the system-audio stream); other tracks are fed by whoever owns
/// them through `appendAudio(_:track:)` (the mic engine). Every source timestamps against the
/// host clock, so the tracks line up without any extra bookkeeping.
public final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let videoIn: AVAssetWriterInput
    public private(set) var audioIns: [AVAssetWriterInput] = []
    public let specs: [AudioTrackSpec]
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    public let queue = DispatchQueue(label: "recorder.samples")
    private let sessionLock = NSLock()
    private var sessionStarted = false
    private var sessionStart = CMTime.zero
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastVideoPTS = CMTime.invalid
    private var lastAudioPTS: [CMTime] = []
    public private(set) var videoFrames = 0
    public private(set) var duplicatedFrames = 0
    public private(set) var droppedVideo = 0
    public private(set) var audioBuffers: [Int] = []
    public private(set) var idleFrames = 0
    public private(set) var streamError: Error?
    private var failureLogged = false
    private var loggedFirstVideo = false
    private var loggedFirstAudio: Set<Int> = []
    private let configuredSize: (w: Int, h: Int)
    public var onStop: ((Error) -> Void)?
    /// Main queue. The writer went to .failed — the file is unusable, tell the user.
    public var onWriterFailure: ((Error) -> Void)?
    public let url: URL

    public init(url: URL, width: Int, height: Int, fps: Int, audioTracks: [AudioTrackSpec]) throws {
        try? FileManager.default.removeItem(at: url)
        self.url = url
        configuredSize = (width, height)
        specs = audioTracks
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let vs: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 3_000_000,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: vs)
        videoIn.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoIn, sourcePixelBufferAttributes: nil)
        writer.add(videoIn)
        // Track order in the file: video, then the audio tracks in the order given.
        for spec in audioTracks {
            // No AVEncoderBitRateKey: the AAC encoder's legal bitrate range depends on the
            // sample rate AND the channel count, and asking for one outside it fails the WHOLE
            // writer with -11861 "Cannot Encode Media / The encoding parameters are not
            // supported" on the first append (the Mac's mic comes in at 24 kHz mono, where
            // 96 kbps is already out of range). Letting the encoder choose is always legal.
            let aus: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: spec.sampleRate,
                AVNumberOfChannelsKey: spec.channels,
            ]
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: aus)
            a.expectsMediaDataInRealTime = true
            a.languageCode = spec.languageCode
            let item = AVMutableMetadataItem()
            item.identifier = .quickTimeUserDataTrackName
            item.value = spec.name as NSString
            let common = AVMutableMetadataItem()
            common.identifier = .commonIdentifierTitle
            common.value = spec.name as NSString
            a.metadata = [item, common]
            writer.add(a)
            audioIns.append(a)
        }
        audioBuffers = Array(repeating: 0, count: audioTracks.count)
        lastAudioPTS = Array(repeating: .invalid, count: audioTracks.count)
        super.init()
        guard writer.startWriting() else {
            throw writer.error ?? NSError(domain: "recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "startWriting failed"])
        }
    }

    /// Single system-audio track (the CLI POC and any one-track caller).
    public convenience init(url: URL, width: Int, height: Int, fps: Int, audio: Bool) throws {
        try self.init(url: url, width: width, height: height, fps: fps, audioTracks: audio ? [.system] : [])
    }

    private func ensureSession(_ pts: CMTime) -> Bool {
        sessionLock.lock()
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
            sessionStarted = true
        }
        let start = sessionStart
        sessionLock.unlock()
        return CMTimeCompare(pts, start) >= 0
    }

    /// Append one audio buffer to `track`. Safe to call from the track's own thread; each
    /// track must only ever be written from one thread (SCK's queue / the mic tap thread).
    public func appendAudio(_ sb: CMSampleBuffer, track: Int) {
        guard writer.status == .writing, track >= 0, track < audioIns.count else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        guard pts.isValid, ensureSession(pts) else { return }
        let input = audioIns[track]
        if !loggedFirstAudio.contains(track) {
            loggedFirstAudio.insert(track)
            let asbd = CMSampleBufferGetFormatDescription(sb).flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            rlog("recorder: first \(specs[track].name) buffer — in \(asbd.map { "\(Int($0.mSampleRate))Hz x\($0.mChannelsPerFrame) fmt \($0.mFormatID)" } ?? "?"), track spec \(Int(specs[track].sampleRate))Hz x\(specs[track].channels)")
        }
        if lastAudioPTS[track].isValid, CMTimeCompare(pts, lastAudioPTS[track]) <= 0 { return }
        guard input.isReadyForMoreMediaData else { return }
        if input.append(sb) {
            lastAudioPTS[track] = pts
            audioBuffers[track] += 1
        } else {
            logFailureOnce("audio track \(track) (\(specs[track].name)) append failed")
        }
    }

    /// One line per recorder — an append failure usually means the writer already went to
    /// .failed and every later sample is silently dropped, so the first one is the diagnosis.
    private func logFailureOnce(_ what: String) {
        guard !failureLogged else { return }
        failureLogged = true
        rlog("recorder: \(what); writer.status=\(writer.status.rawValue) error=\(writer.error.map { String(describing: $0) } ?? "none")")
        if writer.status == .failed, let e = writer.error {
            DispatchQueue.main.async { self.onWriterFailure?(e) }
        }
    }

    public func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sb.isValid, writer.status == .writing else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        switch type {
        case .screen:
            guard let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = atts.first?[.status] as? Int,
                  let status = SCFrameStatus(rawValue: raw), pts.isValid else { return }
            var pb: CVPixelBuffer?
            var isDup = false
            if status == .complete, let img = CMSampleBufferGetImageBuffer(sb) {
                pb = img
            } else if status == .idle, let last = lastPixelBuffer {
                idleFrames += 1
                pb = last
                isDup = true
            } else {
                return
            }
            guard let pixelBuffer = pb, ensureSession(pts) else { return }
            if !loggedFirstVideo {
                loggedFirstVideo = true
                rlog("recorder: first video frame \(CVPixelBufferGetWidth(pixelBuffer))x\(CVPixelBufferGetHeight(pixelBuffer)), writer configured \(configuredSize.w)x\(configuredSize.h)")
            }
            if lastVideoPTS.isValid, CMTimeCompare(pts, lastVideoPTS) <= 0 { return }
            guard videoIn.isReadyForMoreMediaData else { droppedVideo += 1; return }
            if adaptor.append(pixelBuffer, withPresentationTime: pts) {
                lastVideoPTS = pts
                if isDup { duplicatedFrames += 1 } else { videoFrames += 1; lastPixelBuffer = pixelBuffer }
            } else {
                droppedVideo += 1
                logFailureOnce("video append failed")
            }
        case .audio:
            appendAudio(sb, track: 0)
        case .microphone:
            appendAudio(sb, track: audioIns.count > 1 ? 1 : 0)
        @unknown default:
            return
        }
    }

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        streamError = error
        rlog("stream stopped with error: \(error.localizedDescription)")
        onStop?(error)
    }

    public func finish() async {
        videoIn.markAsFinished()
        for a in audioIns { a.markAsFinished() }
        if writer.status == .writing { await writer.finishWriting() }
        if let e = writer.error { rlog("writer error: \(String(describing: e))") }
    }

    /// Wall-clock length of what we actually wrote (first → last video/audio sample).
    public var stats: String {
        let audio = zip(specs, audioBuffers).map { "\($0.name)=\($1)" }.joined(separator: " ")
        return "video=\(videoFrames) dup=\(duplicatedFrames) idle=\(idleFrames) dropped=\(droppedVideo)\(audio.isEmpty ? "" : " " + audio)"
    }
}

/// One running capture: filter → SCStream → Recorder → file.
public final class CaptureSession {
    public let url: URL
    public let label: String
    public let startedAt = Date()
    public let recorder: Recorder
    let stream: SCStream

    private init(url: URL, label: String, recorder: Recorder, stream: SCStream) {
        self.url = url; self.label = label; self.recorder = recorder; self.stream = stream
    }

    public static func shareableContent() async throws -> SCShareableContent {
        try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    }

    /// Display filter — all windows, all system audio. `displayID` nil → main display.
    public static func displayFilter(displayID: CGDirectDisplayID? = nil) async throws -> (SCContentFilter, String) {
        let content = try await shareableContent()
        let wanted = displayID ?? CGMainDisplayID()
        guard let d = content.displays.first(where: { $0.displayID == wanted }) ?? content.displays.first else {
            throw NSError(domain: "recorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "no display"])
        }
        return (SCContentFilter(display: d, excludingWindows: []), "display \(d.displayID) (\(d.width)x\(d.height))")
    }

    /// Largest on-screen window whose app name or title contains `query` (case-insensitive).
    /// NOTE: needs a window-server connection (NSApplication.shared) or SCK asserts CGS_REQUIRE_INIT.
    public static func windowFilter(query: String) async throws -> (SCContentFilter, String, [SCWindow]) {
        let content = try await shareableContent()
        let q = query.lowercased()
        let cands = content.windows.filter { w in
            guard w.isOnScreen, w.windowLayer == 0, w.frame.width > 200, w.frame.height > 200 else { return false }
            let app = w.owningApplication?.applicationName.lowercased() ?? ""
            let title = w.title?.lowercased() ?? ""
            return app.contains(q) || title.contains(q)
        }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }
        guard let w = cands.first else {
            throw NSError(domain: "recorder", code: 3, userInfo: [NSLocalizedDescriptionKey: "no on-screen window matching \"\(query)\""])
        }
        return (SCContentFilter(desktopIndependentWindow: w), "window \(w.windowID) \(w.owningApplication?.applicationName ?? "?") \"\(w.title ?? "")\"", cands)
    }

    /// Longest edge of a recording, in pixels. Full Retina (3456×2234 for a 14" display,
    /// 3024×1890 for a Slack window) at 5 fps is wasteful: a 2-min real recording measured
    /// 42 MB at full Retina vs 24 MB at 2560 wide with slides still readable (2026-09-16).
    /// Every stream config sets `scalesToFit`, so SCK scales into the smaller size.
    public static let maxPixelEdge: CGFloat = 2560

    /// Pixel size of what a filter captures: Retina scale applied, longest edge capped at
    /// `maxPixelEdge` keeping aspect, both dimensions rounded down to even (H.264 wants that).
    public static func pixelSize(of filter: SCContentFilter) -> (Int, Int) {
        let scale = CGFloat(filter.pointPixelScale)
        var w = filter.contentRect.width * scale
        var h = filter.contentRect.height * scale
        if w < 2 || h < 2 { w = 1920; h = 1080 }
        let longest = max(w, h)
        if longest > maxPixelEdge {
            let f = maxPixelEdge / longest
            w *= f; h *= f
        }
        return (max(2, Int(w) & ~1), max(2, Int(h) & ~1))
    }

    public static func start(filter: SCContentFilter, label: String, fps: Int, audio: Bool, url: URL) async throws -> CaptureSession {
        let (w, h) = pixelSize(of: filter)

        let cfg = SCStreamConfiguration()
        cfg.width = w
        cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = true
        cfg.queueDepth = 6
        cfg.capturesAudio = audio
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        cfg.excludesCurrentProcessAudio = true

        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let rec = try Recorder(url: url, width: w, height: h, fps: fps, audio: audio)
        let stream = SCStream(filter: filter, configuration: cfg, delegate: rec)
        try stream.addStreamOutput(rec, type: .screen, sampleHandlerQueue: rec.queue)
        if audio { try stream.addStreamOutput(rec, type: .audio, sampleHandlerQueue: rec.queue) }
        rlog("capturing \(label) → \(w)x\(h) @ \(fps) fps, audio=\(audio) → \(url.path)")
        try await stream.startCapture()
        rlog("capture started")
        return CaptureSession(url: url, label: label, recorder: rec, stream: stream)
    }

    public func stop() async {
        do { try await stream.stopCapture() } catch { rlog("stopCapture: \(error.localizedDescription)") }
        await recorder.finish()
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        rlog("done: \(recorder.stats) bytes=\(size) → \(url.path)")
    }
}
