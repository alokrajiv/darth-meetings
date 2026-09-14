import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics

/// SCStreamOutput → AVAssetWriter bridge. Video frames go through a pixel-buffer adaptor so
/// that `.idle` frames (SCK sends those at the frame interval when nothing changed) can
/// re-append the previous image and keep the track at a constant fps.
public final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let writer: AVAssetWriter
    let videoIn: AVAssetWriterInput
    let audioIn: AVAssetWriterInput?
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    public let queue = DispatchQueue(label: "recorder.samples")
    private var sessionStarted = false
    private var sessionStart = CMTime.zero
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastVideoPTS = CMTime.invalid
    public private(set) var videoFrames = 0
    public private(set) var duplicatedFrames = 0
    public private(set) var droppedVideo = 0
    public private(set) var audioBuffers = 0
    public private(set) var idleFrames = 0
    public private(set) var streamError: Error?
    public var onStop: ((Error) -> Void)?

    public init(url: URL, width: Int, height: Int, fps: Int, audio: Bool) throws {
        try? FileManager.default.removeItem(at: url)
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
        if audio {
            let aus: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ]
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: aus)
            a.expectsMediaDataInRealTime = true
            writer.add(a)
            audioIn = a
        } else {
            audioIn = nil
        }
        super.init()
        guard writer.startWriting() else {
            throw writer.error ?? NSError(domain: "recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "startWriting failed"])
        }
    }

    private func ensureSession(_ pts: CMTime) -> Bool {
        if !sessionStarted {
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
            sessionStarted = true
        }
        return CMTimeCompare(pts, sessionStart) >= 0
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
            if lastVideoPTS.isValid, CMTimeCompare(pts, lastVideoPTS) <= 0 { return }
            guard videoIn.isReadyForMoreMediaData else { droppedVideo += 1; return }
            if adaptor.append(pixelBuffer, withPresentationTime: pts) {
                lastVideoPTS = pts
                if isDup { duplicatedFrames += 1 } else { videoFrames += 1; lastPixelBuffer = pixelBuffer }
            } else {
                droppedVideo += 1
                rlog("video append failed: \(writer.error?.localizedDescription ?? "?")")
            }
        case .audio:
            guard let audioIn, ensureSession(pts) else { return }
            if audioIn.isReadyForMoreMediaData, audioIn.append(sb) { audioBuffers += 1 }
        case .microphone:
            return
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
        audioIn?.markAsFinished()
        if writer.status == .writing { await writer.finishWriting() }
        if let e = writer.error { rlog("writer error: \(e.localizedDescription)") }
    }

    public var stats: String {
        "video=\(videoFrames) dup=\(duplicatedFrames) idle=\(idleFrames) dropped=\(droppedVideo) audio=\(audioBuffers)"
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

    public static func start(filter: SCContentFilter, label: String, fps: Int, audio: Bool, url: URL) async throws -> CaptureSession {
        let scale = CGFloat(filter.pointPixelScale)
        var w = Int(filter.contentRect.width * scale) & ~1
        var h = Int(filter.contentRect.height * scale) & ~1
        if w < 2 || h < 2 { w = 1920; h = 1080 }

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
