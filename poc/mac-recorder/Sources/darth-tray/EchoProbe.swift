import Accelerate
import AVFoundation
import CoreAudio
import ScreenCaptureKit
import RecorderCore

/// `mic_echo_probe` (0.3.10) — how much of the speakers is in the microphone, in a number.
///
/// The problem it measures: on speakers the mic hears the far end a few tens of milliseconds
/// after the system-audio track does, so the server's mix carries the other people twice.
/// Whether Apple's voice processing (`MicCapture`, VPIO) actually removes that on THIS Mac,
/// with THESE speakers, cannot be heard from a log line — so the tray measures it.
///
/// One pass: play a deterministic wideband noise burst (fixed seed, 200 Hz – 7.5 kHz, peak
/// ≈ −16 dBFS) out of the default output while capturing the system-audio track and the
/// microphone; resample both to 16 kHz on a common host-clock time base; slide the mic window
/// over the system track across ±300 ms and take the largest normalised cross-correlation.
///
/// Reading it: **peak** is 0…1, the fraction of the mic window explained by a delayed copy of
/// the system track. Speakers + no echo cancellation is typically 0.3–0.9 with **lag_ms** a
/// small positive number (air + output buffering). With AEC the peak should fall a long way —
/// the same burst, the same room, the residual only. A peak near 0 in BOTH passes means there
/// was no acoustic path at all (headphones, output muted, the burst never played) and the
/// probe proves nothing: check `output_device`. `lag_ms` is only meaningful when the peak is.
///
/// Two deliberate differences from a real recording, both necessary:
/// - the probe's SCK stream sets `excludesCurrentProcessAudio = false`. A recording excludes
///   our own audio; here our own burst IS the reference signal and has to be in the track.
/// - nothing is written to disk. The two tracks live in memory as Float32 for the length of
///   the probe and are dropped with the object — there is no file to delete, no registry row,
///   no upload, and the samples never leave this Mac.
final class EchoProbe: @unchecked Sendable {
    static let shared = EchoProbe()

    /// The whole search window. A speaker → mic path is air plus the output device's
    /// buffering; past 300 ms it is not an echo of this burst.
    static let maxLagS: Double = 0.3
    /// Both tracks come to this rate before correlating. The burst is band-limited to 7.5 kHz,
    /// so nothing that matters is lost and the search costs ~0.6 G MACs instead of 5 G.
    static let analysisRate: Double = 16_000
    /// Burst peak, linear (≈ −16 dBFS): loud enough to leave the speakers, quiet enough not to
    /// make anyone jump.
    static let burstPeak: Float = 0.15
    /// Seconds of each capture thrown away before the analysis window (engine settling, AGC
    /// convergence, and the burst's own 50 ms fade-in).
    static let settleS: Double = 1.0
    /// Longest mic window correlated. 4 s of wideband noise is already a very sharp peak.
    static let windowS: Double = 4.0

    private(set) var running = false
    private let analysisQueue = DispatchQueue(label: "darth.echo-probe.analysis", qos: .userInitiated)

    /// `processing == nil` runs BOTH passes (voice processing on, then off) so the reply shows
    /// the AEC effect as two numbers from the same room a second apart. `completion` is called
    /// on the main queue exactly once.
    func run(seconds: Double, processing: Bool?, completion: @escaping ([String: Any]) -> Void) {
        guard !running else { completion(["error": "busy", "reason": "a probe is already running"]); return }
        let secs = min(30, max(2, seconds))
        running = true
        MicCapture.requestPermission { granted in
            guard granted else {
                self.running = false
                completion(["error": "microphone permission denied"])
                return
            }
            Task { @MainActor in
                let order: [Bool] = processing.map { [$0] } ?? [true, false]
                rlog("echo probe: \(order.count) pass(es) of \(Int(secs)) s — voice processing \(order.map { $0 ? "on" : "off" }.joined(separator: " then "))")
                var passes: [[String: Any]] = []
                for (i, p) in order.enumerated() {
                    if i > 0 { try? await Task.sleep(nanoseconds: 800_000_000) }
                    passes.append(await self.onePass(seconds: secs, processing: p))
                }
                var out: [String: Any] = [
                    "seconds": secs,
                    "passes": passes,
                    "output_device": Self.defaultOutputName() ?? NSNull(),
                    "input_device": AVCaptureDevice.default(for: .audio)?.localizedName ?? NSNull(),
                    "analysis_rate": Int(Self.analysisRate),
                    "lag_search_ms": Int(Self.maxLagS * 1000),
                ]
                // The headline fields are the first pass — the one that was asked for, or the
                // voice-processing one when both ran.
                for k in ["processing", "peak", "lag_ms", "mic_rms_db", "system_rms_db", "error"] {
                    if let v = passes.first?[k] { out[k] = v }
                }
                // Both passes → say the answer outright.
                if passes.count == 2,
                   let on = passes.first(where: { ($0["processing"] as? Bool) == true })?["peak"] as? Double,
                   let off = passes.first(where: { ($0["processing"] as? Bool) == false })?["peak"] as? Double {
                    out["peak_with_processing"] = on
                    out["peak_without_processing"] = off
                    out["peak_drop"] = Double(((off - on) * 1000).rounded() / 1000)
                    out["peak_drop_db"] = on > 0 && off > 0 ? Double((20 * log10(off / on) * 10).rounded() / 10) : NSNull()
                }
                EventLog.shared.log("mic_echo_probe", out,
                                    summary: "echo probe: " + passes.map { p in
                                        let peak = (p["peak"] as? Double).map { String(format: "%.3f", $0) } ?? "—"
                                        let lag = (p["lag_ms"] as? Double).map { String(format: "%.1f ms", $0) } ?? "—"
                                        return "vp=\((p["processing"] as? Bool) == true ? "on" : "off") peak=\(peak) lag=\(lag)\((p["error"] as? String).map { " error=\($0)" } ?? "")"
                                    }.joined(separator: " · "))
                self.running = false
                completion(out)
            }
        }
    }

    // MARK: one pass

    @MainActor
    private func onePass(seconds: Double, processing: Bool) async -> [String: Any] {
        var out: [String: Any] = ["processing": processing]
        let systemSink = ProbeAudioSink(label: "system")
        let micSink = ProbeAudioSink(label: "mic")
        let mic = MicCapture(voiceProcessing: processing)
        let tone = ProbeTone()
        var stream: SCStream?
        do {
            stream = try await Self.startSystemAudio(sink: systemSink)
        } catch {
            out["error"] = "system audio capture failed: \(error.localizedDescription)"
            return out
        }
        mic.onBuffer = { sb in micSink.append(sb) }
        do {
            try mic.start()
        } catch {
            out["error"] = "microphone failed: \(error.localizedDescription)"
            if let stream { try? await stream.stopCapture() }
            return out
        }
        out["mic_processing"] = mic.voiceProcessingJSON
        out["mic_format"] = mic.formatLabel ?? NSNull()
        // Both captures need a moment before the burst, or the first second of it is missing
        // from one of the two tracks and the window we analyse is not the one we played.
        try? await Task.sleep(nanoseconds: 500_000_000)
        do {
            out["burst_rate"] = Int(try tone.play(seconds: seconds, peak: Self.burstPeak))
        } catch {
            out["error"] = "could not play the test burst: \(error.localizedDescription)"
        }
        try? await Task.sleep(nanoseconds: UInt64((seconds + 0.6) * 1_000_000_000))
        tone.stop()
        mic.onBuffer = nil
        mic.stop()
        if let stream { try? await stream.stopCapture() }
        out["mic_agc_db"] = Double((mic.conditioner.gainDb * 10).rounded() / 10)

        let m = micSink.track()
        let s = systemSink.track()
        out["mic_samples"] = m.samples.count
        out["system_samples"] = s.samples.count
        guard m.rate > 0, s.rate > 0 else {
            if out["error"] == nil { out["error"] = "no audio captured (mic \(m.samples.count), system \(s.samples.count))" }
            return out
        }
        out["mic_rate"] = Int(m.rate)
        out["system_rate"] = Int(s.rate)
        let (analysis, note) = await withCheckedContinuation { (cont: CheckedContinuation<(Analysis?, String?), Never>) in
            analysisQueue.async { cont.resume(returning: Self.analyse(mic: m, system: s)) }
        }
        guard let a = analysis else {
            if out["error"] == nil { out["error"] = note ?? "could not correlate the two tracks" }
            return out
        }
        out["peak"] = Double((a.peak * 1000).rounded() / 1000)
        out["lag_ms"] = Double((a.lagMs * 10).rounded() / 10)
        out["mic_rms_db"] = Double((a.micRmsDb * 10).rounded() / 10)
        out["system_rms_db"] = Double((a.systemRmsDb * 10).rounded() / 10)
        out["window_s"] = Double((a.windowS * 100).rounded() / 100)
        rlog(String(format: "echo probe: vp=%@ peak %.3f at %+.1f ms · mic %.1f dB · system %.1f dB · window %.1f s",
                    processing ? "on" : "off", a.peak, a.lagMs, a.micRmsDb, a.systemRmsDb, a.windowS))
        return out
    }

    private static func startSystemAudio(sink: ProbeAudioSink) async throws -> SCStream {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let d = content.displays.first else {
            throw NSError(domain: "echo-probe", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display to attach the audio stream to"])
        }
        let cfg = SCStreamConfiguration()
        cfg.width = 16; cfg.height = 16
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        cfg.showsCursor = false
        cfg.queueDepth = 5
        cfg.capturesAudio = true
        cfg.sampleRate = 48_000
        cfg.channelCount = 2
        // Unlike a recording: our own burst is the reference and must be in the track.
        cfg.excludesCurrentProcessAudio = false
        let s = SCStream(filter: SCContentFilter(display: d, excludingWindows: []), configuration: cfg, delegate: sink)
        try s.addStreamOutput(sink, type: .audio, sampleHandlerQueue: sink.queue)
        try await s.startCapture()
        return s
    }

    /// Name of the device the burst goes to — a probe against headphones has no acoustic path
    /// and both passes read ~0, which is not an AEC result.
    static func defaultOutputName() -> String? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                              mScope: kAudioObjectPropertyScopeGlobal,
                                              mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id) == noErr else { return nil }
        var nameAddr = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
                                                  mScope: kAudioObjectPropertyScopeGlobal,
                                                  mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &name) == noErr, let n = name else { return nil }
        return n.takeRetainedValue() as String
    }

    // MARK: the burst

    /// Deterministic band-limited noise: an LCG with a fixed seed through two one-pole
    /// low-passes at 7.5 kHz and one one-pole high-pass at 200 Hz, normalised to `peak`, with
    /// 50 ms fades so it neither clicks nor smears the correlation peak. Noise (not a repeated
    /// chirp) because its autocorrelation is a single spike: no second peak can be mistaken for
    /// the echo.
    static func burst(frames: Int, rate: Double, peak: Float) -> [Float] {
        guard frames > 0, rate > 0 else { return [] }
        var state: UInt64 = 0x5EED_1234_ABCD_0001
        var x = [Float](repeating: 0, count: frames)
        let lpA = Float(1 - exp(-2 * Double.pi * 7_500 / rate))
        let hpA = Float(exp(-2 * Double.pi * 200 / rate))
        var lp1: Float = 0, lp2: Float = 0, hpIn: Float = 0, hpOut: Float = 0
        for i in 0..<frames {
            state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let n = Float(Int32(truncatingIfNeeded: Int64(bitPattern: state >> 33))) / Float(Int32.max)
            lp1 += lpA * (n - lp1)
            lp2 += lpA * (lp1 - lp2)
            hpOut = hpA * (hpOut + lp2 - hpIn)
            hpIn = lp2
            x[i] = hpOut
        }
        var mx: Float = 0
        for v in x { mx = max(mx, abs(v)) }
        let g = mx > 0 ? peak / mx : 0
        let fade = max(1, min(frames / 2, Int(0.05 * rate)))
        for i in 0..<frames {
            var w: Float = 1
            if i < fade { w = Float(i) / Float(fade) } else if i >= frames - fade { w = Float(frames - i) / Float(fade) }
            x[i] *= g * w
        }
        return x
    }

    // MARK: analysis

    struct Track: Sendable {
        let samples: [Float]
        /// Hz the samples were captured at.
        let rate: Double
        /// Host-clock seconds of sample 0 (both sides timestamp against `CMClockGetHostTimeClock`,
        /// which is what makes a lag in milliseconds mean anything).
        let t0: Double
    }

    struct Analysis: Sendable {
        let peak: Double
        /// Positive = the mic heard it AFTER the system track did, which is what an echo is.
        let lagMs: Double
        let micRmsDb: Double
        let systemRmsDb: Double
        let windowS: Double
    }

    static func analyse(mic: Track, system: Track) -> (Analysis?, String?) {
        let r = analysisRate
        let m = resample(mic.samples, from: mic.rate, to: r)
        let s = resample(system.samples, from: system.rate, to: r)
        guard m.count > Int(r), s.count > Int(r) else { return (nil, "too few samples after resampling (mic \(m.count), system \(s.count))") }
        let nLags = 2 * Int(maxLagS * r) + 1
        // The mic window starts after the settle time, and never before the system track can
        // cover a −maxLag shift of it.
        let minSkip = Int(max(0, ((system.t0 + maxLagS) - mic.t0) * r).rounded(.up))
        let skip = max(Int(settleS * r), minSkip)
        let tailGuard = Int(0.4 * r)
        var length = min(Int(windowS * r), m.count - skip - tailGuard)
        let k0 = Int((((mic.t0 + Double(skip) / r) - maxLagS - system.t0) * r).rounded())
        guard k0 >= 0 else { return (nil, "the system capture starts after the mic window") }
        length = min(length, s.count - k0 - nLags + 1)
        guard length > Int(0.5 * r) else { return (nil, "the two captures overlap for less than 0.5 s") }
        let a = Array(m[skip..<(skip + length)])
        let b = Array(s[k0..<(k0 + nLags + length - 1)])

        var corr = [Float](repeating: 0, count: nLags)
        corr.withUnsafeMutableBufferPointer { cp in
            b.withUnsafeBufferPointer { bp in
                a.withUnsafeBufferPointer { ap in
                    guard let c = cp.baseAddress, let bb = bp.baseAddress, let aa = ap.baseAddress else { return }
                    vDSP_conv(bb, 1, aa, 1, c, 1, vDSP_Length(nLags), vDSP_Length(length))
                }
            }
        }
        var energyA: Double = 0
        for v in a { energyA += Double(v) * Double(v) }
        guard energyA > 0 else { return (nil, "the mic track is silent") }
        var window: Double = 0
        for i in 0..<length { window += Double(b[i]) * Double(b[i]) }
        var best = 0
        var bestNcc = 0.0
        var bestEnergyB = window
        for n in 0..<nLags {
            if n > 0 {
                let entering = Double(b[n + length - 1]), leaving = Double(b[n - 1])
                window = max(0, window + entering * entering - leaving * leaving)
            }
            let denom = (energyA * window).squareRoot()
            guard denom > 1e-12 else { continue }
            let v = abs(Double(corr[n])) / denom
            if v > bestNcc { bestNcc = v; best = n; bestEnergyB = window }
        }
        let micTime = mic.t0 + Double(skip) / r
        let systemTime = system.t0 + Double(k0 + best) / r
        let db = { (energy: Double) -> Double in
            let rms = (energy / Double(length)).squareRoot()
            return rms > 0 ? 20 * log10(rms) : -120
        }
        return (Analysis(peak: bestNcc, lagMs: (micTime - systemTime) * 1000,
                         micRmsDb: db(energyA), systemRmsDb: db(bestEnergyB),
                         windowS: Double(length) / r), nil)
    }

    /// Crude but symmetric: a box low-pass the width of the decimation factor, then linear
    /// interpolation. Both tracks get the same treatment, so the comparison between the two
    /// passes — which is the whole point — is unaffected by its imperfection.
    static func resample(_ x: [Float], from: Double, to: Double) -> [Float] {
        guard from > 0, to > 0, x.count > 1 else { return [] }
        if abs(from - to) < 1 { return x }
        var src = x
        let decim = Int((from / to).rounded(.down))
        if decim >= 2 {
            var y = [Float](repeating: 0, count: x.count)
            var acc: Float = 0
            for i in 0..<x.count {
                acc += x[i]
                if i >= decim { acc -= x[i - decim] }
                y[i] = acc / Float(min(i + 1, decim))
            }
            src = y
        }
        let n = Int(Double(x.count) * to / from)
        guard n > 1 else { return [] }
        var out = [Float](repeating: 0, count: n)
        let step = from / to
        for i in 0..<n {
            let p = Double(i) * step
            let i0 = min(Int(p), src.count - 1)
            let i1 = min(i0 + 1, src.count - 1)
            let f = Float(p - Double(i0))
            out[i] = src[i0] * (1 - f) + src[i1] * f
        }
        return out
    }
}

/// Collects one capture's Float32 samples in memory, folded to mono, with the host-clock time
/// of the first sample. Nothing is written anywhere; the arrays die with the probe.
final class ProbeAudioSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue: DispatchQueue
    private let label: String
    private let lock = NSLock()
    private var samples: [Float] = []
    private var rate: Double = 0
    private var firstPTS: Double?

    init(label: String) {
        self.label = label
        queue = DispatchQueue(label: "darth.echo-probe.\(label)")
        super.init()
    }

    func track() -> EchoProbe.Track {
        lock.lock(); defer { lock.unlock() }
        return EchoProbe.Track(samples: samples, rate: rate, t0: firstPTS ?? 0)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        append(sb)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        rlog("echo probe: \(label) stream stopped — \(error.localizedDescription)")
    }

    /// Float32 PCM CMSampleBuffer → mono Float32, appended. Anything else is ignored (the
    /// probe then reports "no audio captured" rather than a wrong number).
    func append(_ sb: CMSampleBuffer) {
        guard let fd = CMSampleBufferGetFormatDescription(sb),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0, asbd.mBitsPerChannel == 32 else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0 else { return }
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let abl = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        let st = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, bufferListSizeNeededOut: nil, bufferListOut: abl, bufferListSize: needed,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &block)
        guard st == noErr else { return }
        var mono = [Float](repeating: 0, count: frames)
        var contributors = 0
        for buf in UnsafeMutableAudioBufferListPointer(abl) {
            guard let data = buf.mData else { continue }
            let nch = max(1, Int(buf.mNumberChannels))
            let count = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
            let p = data.bindMemory(to: Float.self, capacity: count)
            if nch == 1 {
                for i in 0..<min(frames, count) { mono[i] += p[i] }
            } else {
                for i in 0..<min(frames, count / nch) {
                    var sum: Float = 0
                    for c in 0..<nch { sum += p[i * nch + c] }
                    mono[i] += sum / Float(nch)
                }
            }
            contributors += 1
        }
        withExtendedLifetime(block) {}
        guard contributors > 0 else { return }
        if contributors > 1 {
            let g = 1 / Float(contributors)
            for i in 0..<frames { mono[i] *= g }
        }
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        lock.lock()
        if firstPTS == nil {
            firstPTS = pts
            rate = asbd.mSampleRate
            rlog("echo probe: first \(label) buffer — \(Int(asbd.mSampleRate)) Hz × \(asbd.mChannelsPerFrame) ch, \(frames) frames")
        }
        samples.append(contentsOf: mono)
        lock.unlock()
    }
}

/// Plays the burst out of the default output for the length of one pass. Its own engine — the
/// mic's engine is an input graph and must not be touched here.
final class ProbeTone {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var started = false

    /// Returns the sample rate the burst was rendered at.
    func play(seconds: Double, peak: Float) throws -> Double {
        let hw = engine.outputNode.outputFormat(forBus: 0)
        let rate = hw.sampleRate > 0 ? hw.sampleRate : 48_000
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else {
            throw NSError(domain: "echo-probe", code: 2, userInfo: [NSLocalizedDescriptionKey: "no output format at \(Int(rate)) Hz"])
        }
        let frames = AVAudioFrameCount(seconds * rate)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames),
              let chans = buf.floatChannelData else {
            throw NSError(domain: "echo-probe", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not build the burst buffer"])
        }
        buf.frameLength = frames
        let mono = EchoProbe.burst(frames: Int(frames), rate: rate, peak: peak)
        for c in 0..<Int(fmt.channelCount) {
            let p = chans[c]
            for i in 0..<Int(frames) { p[i] = mono[i] }
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: fmt)
        engine.prepare()
        try engine.start()
        started = true
        player.scheduleBuffer(buf, at: nil, options: [], completionHandler: nil)
        player.play()
        rlog("echo probe: playing a \(String(format: "%.0f", seconds)) s burst at \(Int(rate)) Hz, peak \(String(format: "%.0f", 20 * log10(Double(peak)))) dBFS")
        return rate
    }

    func stop() {
        guard started else { return }
        player.stop()
        engine.stop()
        started = false
    }
}
