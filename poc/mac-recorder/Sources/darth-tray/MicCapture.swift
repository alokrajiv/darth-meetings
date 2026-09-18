import AVFoundation
import RecorderCore

/// The microphone as its OWN track. `AVAudioEngine` input tap → CMSampleBuffer on the host
/// clock (the same clock ScreenCaptureKit timestamps with), handed to the current segment's
/// writer as audio track 2. Never mixed with system audio: the meeting comes back with "them"
/// and "you" separable.
///
/// Microphone permission is requested the first time a recording starts. Denied → we record
/// without the mic track and say so in the log; the recording itself never fails for this.
///
/// Channel count (0.3.1): the input node reports whatever format the device is in RIGHT NOW,
/// and another app can change that. WhatsApp voice calls left the MacBook Pro mic at
/// 48 kHz × 3 ch (2026-09-16 21:23 and 2026-09-17 22:53 SGT); every recording that worked
/// had 1 ch. An AAC writer input with 3 channels and no AVChannelLayoutKey raises
/// NSInvalidArgumentException — so anything above 2 channels is downmixed to mono HERE and
/// `format` is the format the writer actually receives, never the raw hardware one.
final class MicCapture {
    private let engine = AVAudioEngine()
    private var tapped = false
    /// The format of the buffers handed to `onBuffer` (mono when the hardware has > 2 ch).
    private(set) var format: AVAudioFormat?
    /// What the device reported when the tap was installed.
    private(set) var hardwareFormat: AVAudioFormat?
    private var downmix = false
    private(set) var downmixDropped = 0
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
        let hw = input.inputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else {
            throw NSError(domain: "mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input format (no microphone or permission denied)"])
        }
        hardwareFormat = hw
        let out: AVAudioFormat
        if hw.channelCount > 2,
           let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hw.sampleRate, channels: 1, interleaved: false) {
            out = mono
            downmix = true
            rlog("mic: hardware format \(Int(hw.sampleRate)) Hz × \(hw.channelCount) ch — downmixing to mono for the track")
        } else {
            out = hw
            downmix = false
        }
        format = out
        // The tap must use the node's own format; the conversion happens in the callback.
        input.installTap(onBus: 0, bufferSize: 2048, format: hw) { [weak self] raw, when in
            guard let self else { return }
            self.buffersSeen += 1
            let buf: AVAudioPCMBuffer
            if self.downmix {
                guard let mono = MicCapture.downmixToMono(raw, format: out) else {
                    self.downmixDropped += 1
                    if self.downmixDropped == 1 { rlog("mic: could not downmix a \(raw.format.channelCount) ch buffer (\(raw.format.commonFormat.rawValue)) — dropping") }
                    return
                }
                buf = mono
            } else {
                buf = raw
            }
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
        rlog("mic: capturing \(Int(hw.sampleRate)) Hz × \(hw.channelCount) ch from \(dev?.localizedName ?? "default input")\(downmix ? " → mono track" : "")")
    }

    /// Average all channels of a Float32 buffer into one. Interleaved Float32 keeps its
    /// samples in channelData[0] with stride = channel count; deinterleaved has one pointer
    /// per channel. Anything that is not Float32 returns nil (the caller drops the buffer).
    static func downmixToMono(_ src: AVAudioPCMBuffer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let n = Int(src.frameLength)
        let c = Int(src.format.channelCount)
        guard c > 0, let chans = src.floatChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(n, 1))),
              let dst = out.floatChannelData?[0] else { return nil }
        let inv = 1 / Float(c)
        if src.format.isInterleaved {
            let p = chans[0]
            for i in 0..<n {
                var s: Float = 0
                for k in 0..<c { s += p[i * c + k] }
                dst[i] = s * inv
            }
        } else {
            for i in 0..<n {
                var s: Float = 0
                for k in 0..<c { s += chans[k][i] }
                dst[i] = s * inv
            }
        }
        out.frameLength = AVAudioFrameCount(n)
        return out
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
