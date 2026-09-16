import AVFoundation
import RecorderCore

/// The microphone as its OWN track. `AVAudioEngine` input tap → CMSampleBuffer on the host
/// clock (the same clock ScreenCaptureKit timestamps with), handed to the current segment's
/// writer as audio track 2. Never mixed with system audio: the meeting comes back with "them"
/// and "you" separable.
///
/// Microphone permission is requested the first time a recording starts. Denied → we record
/// without the mic track and say so in the log; the recording itself never fails for this.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var tapped = false
    private(set) var format: AVAudioFormat?
    /// Called on the tap's own thread.
    var onBuffer: ((CMSampleBuffer) -> Void)?
    private(set) var buffersSeen = 0
    private(set) var peak: Float = 0
    /// Level meter (0.2.6): window RMS, audible flag, seconds since audible.
    let meter = LevelMeter()
    private var startedAt = Date()

    static var authorization: AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .audio) }

    /// Ask once; `done` on the main queue. `.notDetermined` shows the system prompt.
    static func requestPermission(_ done: @escaping (Bool) -> Void) {
        switch authorization {
        case .authorized: DispatchQueue.main.async { done(true) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { ok in DispatchQueue.main.async { done(ok) } }
        default: DispatchQueue.main.async { done(false) }
        }
    }

    /// Start the engine and tap. Throws if the input node has no usable format (no input
    /// device, or permission denied).
    func start() throws {
        guard !tapped else { return }
        let input = engine.inputNode
        let fmt = input.inputFormat(forBus: 0)
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            throw NSError(domain: "mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input format (no microphone or permission denied)"])
        }
        format = fmt
        input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buf, when in
            guard let self else { return }
            self.buffersSeen += 1
            if let m = LevelMeter.measure(buf) {
                self.peak = max(self.peak, m.peak)
                self.meter.note(peak: m.peak, rms: m.rms)
            }
            if self.buffersSeen == 1 {
                rlog("mic: first buffer \(Int(Date().timeIntervalSince(self.startedAt) * 1000)) ms after start — \(Int(buf.format.sampleRate)) Hz × \(buf.format.channelCount) ch, \(buf.frameLength) frames")
            }
            guard let sb = MicCapture.sampleBuffer(from: buf, when: when) else { return }
            self.onBuffer?(sb)
        }
        tapped = true
        startedAt = Date()
        engine.prepare()
        try engine.start()
        let dev = AVCaptureDevice.default(for: .audio)
        rlog("mic: capturing \(Int(fmt.sampleRate)) Hz × \(fmt.channelCount) ch from \(dev?.localizedName ?? "default input")")
    }

    func stop() {
        guard tapped else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        tapped = false
        rlog("mic: stopped after \(buffersSeen) buffers, peak \(String(format: "%.3f", peak))")
    }

    /// AVAudioPCMBuffer + AVAudioTime → CMSampleBuffer timestamped on the host clock, which
    /// is the clock SCK uses, so the tracks line up without any offset bookkeeping.
    static func sampleBuffer(from buf: AVAudioPCMBuffer, when: AVAudioTime) -> CMSampleBuffer? {
        let pts: CMTime = when.isHostTimeValid
            ? CMClockMakeHostTimeFromSystemUnits(when.hostTime)
            : CMClockGetTime(CMClockGetHostTimeClock())
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(buf.format.sampleRate)),
            presentationTimeStamp: pts,
            decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        let fmt = buf.format.formatDescription
        let status = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: fmt,
            sampleCount: CMItemCount(buf.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sb)
        guard status == noErr, let sb else { return nil }
        let set = CMSampleBufferSetDataBufferFromAudioBufferList(
            sb, blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, bufferList: buf.audioBufferList)
        guard set == noErr else { return nil }
        // Created with dataReady:false — the buffer only becomes appendable once the data is
        // attached AND it is marked ready. Without this every append fails and, worse, the
        // AVAssetWriter goes to .failed with "Cannot Encode Media" (cost us one test run).
        CMSampleBufferSetDataReady(sb)
        return sb
    }
}
