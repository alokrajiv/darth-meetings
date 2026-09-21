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
/// and another app can change that. WhatsApp voice calls put the MacBook Pro mic into its
/// voice-processing mode, and other clients then see 48 kHz × 3 ch (2026-09-16 21:23,
/// 2026-09-17 22:53 SGT); every recording that worked had 1 ch. An AAC writer input with
/// 3 channels and no AVChannelLayoutKey raises NSInvalidArgumentException — so anything above
/// 2 channels is reduced to mono HERE and `format` is the format the writer actually receives.
///
/// Level (0.3.2): that raw 3-channel feed is also ~40 dB quieter than the normal processed
/// mono path (2026-09-18 12:37 WhatsApp call: speech peaked at −42 dBFS, RMS −55 dB, and the
/// transcript missed Alok). Averaging the three capsules lost another ~12 dB. So the mono
/// track is now the LOUDEST channel (`MicConditioner`, 3 dB hysteresis) with automatic gain:
/// target peak −12 dBFS, up to +36 dB, instant attack / 24 dB·s⁻¹ release, and a downward
/// expander (−20 dB) on buffers that sit within 12 dB of the tracked noise floor so silence
/// stays silent for the health meter. Gain is applied to EVERY mic buffer (a normal 1-channel
/// mic at a healthy level gets gain 1 — the AGC never attenuates).
///
/// **Echo (0.3.10).** On speakers the mic also hears the far end, tens of milliseconds late,
/// and the server's mix (system track + mic track) then carries the other people TWICE —
/// diarization smears and the transcript doubles. So the input node now runs Apple's voice
/// processing IO unit (`setVoiceProcessingEnabled(true)`): acoustic echo cancellation with the
/// system's own output as the reference, plus noise suppression and Apple's AGC. Four things
/// that path forces, each logged:
///
/// 1. **Order.** Voice processing must be switched on BEFORE the tap is installed and before
///    the engine runs — it rebuilds the IO unit. The node's format changes with it (mono,
///    usually a different sample rate), so the tap, `format` and the writer's track spec all
///    come from `outputFormat(forBus: 0)` re-read AFTER enabling, never from the hardware
///    format we looked at first. The raw path still reads `inputFormat(forBus: 0)` and still
///    folds > 2 channels to mono the 0.3.1 way.
/// 2. **Ducking.** macOS 14 ducks every OTHER app's audio while voice processing runs — which
///    would duck the call we are recording. `voiceProcessingOtherAudioDuckingConfiguration`
///    is set to `(enableAdvancedDucking: false, duckingLevel: .min)`. (Deployment target is
///    macOS 14, so the API is always present; there is nothing to `#available`-guard.)
/// 3. **Two AGCs do not stack.** Apple's AGC stays ON and `MicConditioner`'s own gain is
///    capped at +12 dB while voice processing is active (+36 dB on the raw path). The channel
///    pick and the expander stay as the fallback for when it is off. `isVoiceProcessingBypassed`
///    is held false.
/// 4. **Fallback.** If enabling throws, or the engine refuses to start with it on, the whole
///    engine is thrown away and started once more raw — "mic: voice processing unavailable —
///    raw input" — and `voiceProcessing` records `.unavailable` so the event log says so.
final class MicCapture {
    /// What this capture's microphone ACTUALLY ran with (not what was asked for).
    /// `.unavailable` = asked for, refused by the system, running raw.
    enum VoiceProcessing: String { case on, off, unavailable }

    private var engine = AVAudioEngine()
    private var tapped = false
    /// The format of the buffers handed to `onBuffer` (mono when the hardware has > 1 ch).
    private(set) var format: AVAudioFormat?
    /// What the node reported when the tap was installed (the hardware format on the raw path,
    /// the voice-processing output format when that is on).
    private(set) var hardwareFormat: AVAudioFormat?
    private var reduce = false
    private(set) var reduceDropped = 0
    /// Called on the tap's own thread.
    var onBuffer: ((CMSampleBuffer) -> Void)?
    private(set) var buffersSeen = 0
    private(set) var peak: Float = 0
    /// Level meter (0.2.6): window RMS, audible flag, seconds since audible. Measures the
    /// CONDITIONED signal — what the file gets.
    let meter = LevelMeter()
    /// Channel pick + AGC (0.3.2).
    let conditioner = MicConditioner()
    private var startedAt = Date()
    /// 0.3.10: what the caller asked for.
    let wantsVoiceProcessing: Bool
    /// 0.3.10: what we got.
    private(set) var voiceProcessing: VoiceProcessing = .off
    /// 0.3.10: ceiling for `MicConditioner` when Apple's AGC is already running.
    static let agcCapWithVoiceProcessingDb: Float = 12
    static let agcCapRawDb: Float = 36

    init(voiceProcessing: Bool = false) { wantsVoiceProcessing = voiceProcessing }

    /// `true | false | "unavailable"` for the event log and the ws payloads.
    var voiceProcessingJSON: Any { voiceProcessing == .unavailable ? "unavailable" : (voiceProcessing == .on) }
    /// "24000 Hz × 1 ch" — the format the writer's mic track was built from.
    var formatLabel: String? { format.map { "\(Int($0.sampleRate)) Hz × \($0.channelCount) ch" } }
    var hardwareFormatLabel: String? { hardwareFormat.map { "\(Int($0.sampleRate)) Hz × \($0.channelCount) ch" } }

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
    /// device, or permission denied). With voice processing asked for and refused, this
    /// still succeeds — on the raw path.
    func start() throws {
        guard !tapped else { return }
        do {
            try startEngine(voiceProcessing: wantsVoiceProcessing)
            voiceProcessing = wantsVoiceProcessing ? .on : .off
        } catch {
            guard wantsVoiceProcessing else { throw error }
            rlog("mic: voice processing unavailable — raw input (\(error.localizedDescription))")
            EventLog.shared.log("mic_voice_processing_unavailable", ["error": error.localizedDescription])
            // A half-configured voice-processing IO unit is not reusable: start over on a
            // brand-new engine so the retry is a genuine raw path.
            resetEngine()
            try startEngine(voiceProcessing: false)
            voiceProcessing = .unavailable
        }
    }

    private func resetEngine() {
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        engine.stop()
        engine = AVAudioEngine()
        buffersSeen = 0
        reduceDropped = 0
        peak = 0
    }

    private func startEngine(voiceProcessing: Bool) throws {
        let input = engine.inputNode
        if voiceProcessing {
            // BEFORE the tap and before the engine runs — enabling it rebuilds the IO unit.
            try input.setVoiceProcessingEnabled(true)
            input.isVoiceProcessingBypassed = false
            input.isVoiceProcessingAGCEnabled = true          // Apple's AGC owns the level now
            // macOS 14 would otherwise duck the call itself while we listen.
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
            rlog("mic: voice processing ON — AEC + noise suppression + Apple AGC; other-app ducking disabled (advanced=false, level=min); bypass=false")
        }
        // The format CHANGES when voice processing is on, so read it back now. `outputFormat`
        // is what the node will actually hand the tap; the raw path keeps reading the hardware
        // format the way 0.3.1 did.
        var hw = voiceProcessing ? input.outputFormat(forBus: 0) : input.inputFormat(forBus: 0)
        if voiceProcessing {
            rlog("mic: voice-processing formats — input \(fmt(input.inputFormat(forBus: 0))), output \(fmt(hw))")
            if hw.sampleRate <= 0 || hw.channelCount == 0 {
                hw = input.inputFormat(forBus: 0)
                rlog("mic: voice-processing output format was empty — falling back to the input format \(fmt(hw))")
            }
        }
        guard hw.sampleRate > 0, hw.channelCount > 0 else {
            throw NSError(domain: "mic", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input format (no microphone or permission denied)"])
        }
        hardwareFormat = hw
        // The writer always gets Float32 mono: one channel picked from the hardware feed, gained.
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hw.sampleRate, channels: 1, interleaved: false) else {
            throw NSError(domain: "mic", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not build a mono format at \(Int(hw.sampleRate)) Hz"])
        }
        reduce = hw.channelCount > 1
        if reduce { rlog("mic: hardware format \(fmt(hw)) — mono track = loudest channel + AGC") }
        format = mono
        conditioner.reset(channels: Int(hw.channelCount))
        // Two AGCs chasing each other is worse than none: Apple's stays, ours is capped.
        conditioner.setMaxGainDb(voiceProcessing ? Self.agcCapWithVoiceProcessingDb : Self.agcCapRawDb)
        // The tap must use the node's own format; the conversion happens in the callback.
        input.installTap(onBus: 0, bufferSize: 2048, format: hw) { [weak self] raw, when in
            guard let self else { return }
            self.buffersSeen += 1
            guard let buf = self.conditioner.process(raw, into: mono) else {
                self.reduceDropped += 1
                if self.reduceDropped == 1 { rlog("mic: could not condition a \(raw.format.channelCount) ch buffer (\(raw.format.commonFormat.rawValue)) — dropping") }
                return
            }
            if let m = LevelMeter.measure(buf) {
                self.peak = max(self.peak, m.peak)
                self.meter.note(peak: m.peak, rms: m.rms)
            }
            if self.buffersSeen == 1 {
                rlog("mic: first buffer \(Int(Date().timeIntervalSince(self.startedAt) * 1000)) ms after start — \(fmt(raw.format)), \(raw.frameLength) frames")
            }
            guard let sb = MicCapture.sampleBuffer(from: buf, when: when) else { return }
            self.onBuffer?(sb)
        }
        tapped = true
        startedAt = Date()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            // Leave nothing behind for the raw retry to trip over.
            input.removeTap(onBus: 0)
            tapped = false
            throw error
        }
        let dev = AVCaptureDevice.default(for: .audio)
        rlog("mic: capturing \(fmt(hw)) from \(dev?.localizedName ?? "default input")\(reduce ? " → mono track" : "")"
             + " · voice processing \(voiceProcessing ? "ON" : "off") · AGC cap \(Int(voiceProcessing ? Self.agcCapWithVoiceProcessingDb : Self.agcCapRawDb)) dB")
    }

    private func fmt(_ f: AVAudioFormat) -> String { "\(Int(f.sampleRate)) Hz × \(f.channelCount) ch" }

    func stop() {
        guard tapped else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        tapped = false
        rlog("mic: stopped after \(buffersSeen) buffers, peak \(String(format: "%.3f", peak)) — vp=\(voiceProcessing.rawValue) — \(conditioner.summary)")
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

/// Mono channel pick + automatic gain for the mic track (0.3.2). Runs on the tap thread; the
/// counters are read from the main thread for logs only (approximate is fine).
///
/// 0.3.10: the ceiling is no longer a constant. With Apple's voice processing running, its AGC
/// already holds the level, so ours is capped at +12 dB — two AGCs stacked hunt each other and
/// pump. `setMaxGainDb` survives `reset`.
final class MicConditioner {
    static let targetPeak: Float = 0.25          // −12 dBFS
    static let defaultMaxGain: Float = 63        // +36 dB
    static let releasePerBuffer: Float = 1.32    // ≈ +2.4 dB per 100 ms buffer = 24 dB/s (a 40 dB deficit closes in ~1.5 s)
    static let expanderGain: Float = 0.1         // −20 dB on noise-only buffers
    static let signalOverFloor: Float = 4        // 12 dB above the tracked floor = signal

    private var channelEma: [Float] = []
    private(set) var channel = 0
    private(set) var channelSwitches = 0
    private(set) var hardwareChannels = 1
    private var gain: Float = 1
    private var appliedGain: Float = 1
    private var peakTrack: Float = 0
    private var floor: Float = -1
    private(set) var minGainDb: Float = 0
    private(set) var maxGainDb: Float = 0
    private(set) var signalBuffers = 0
    private(set) var noiseBuffers = 0
    /// Linear ceiling for the AGC — see `setMaxGainDb`.
    private(set) var maxGain: Float = MicConditioner.defaultMaxGain
    /// Consecutive signal buffers so far (0.3.4): gain only RISES after 3 (300 ms) — speech is
    /// sustained, a click or a key press is one buffer, and 0.3.3 still boosted those by 24 dB
    /// before anyone had spoken.
    private var signalRun = 0
    static let riseAfterBuffers = 3

    /// The AGC ceiling in dB. Not touched by `reset` — the caller sets it once per capture.
    func setMaxGainDb(_ db: Float) { maxGain = max(1, powf(10, db / 20)) }
    var maxGainCeilingDb: Float { 20 * log10f(max(maxGain, 1)) }

    func reset(channels: Int) {
        hardwareChannels = max(1, channels)
        channelEma = Array(repeating: 0, count: hardwareChannels)
        channel = 0; channelSwitches = 0
        gain = 1; appliedGain = 1; peakTrack = 0; floor = -1
        minGainDb = 0; maxGainDb = 0; signalBuffers = 0; noiseBuffers = 0; signalRun = 0
    }

    var gainDb: Float { 20 * log10f(max(appliedGain, 1e-6)) }
    var summary: String {
        String(format: "channel %d/%d (%d switches), gain now %+.0f dB (range %+.0f…%+.0f, cap %+.0f), signal %d / noise %d buffers",
               channel + 1, hardwareChannels, channelSwitches, gainDb, minGainDb, maxGainDb, maxGainCeilingDb, signalBuffers, noiseBuffers)
    }
    var snapshot: [String: Any] {
        ["hw_channels": hardwareChannels, "channel": channel + 1, "channel_switches": channelSwitches,
         "gain_db": Double((gainDb * 10).rounded() / 10), "gain_min_db": Double((minGainDb * 10).rounded() / 10),
         "gain_max_db": Double((maxGainDb * 10).rounded() / 10), "gain_cap_db": Double((maxGainCeilingDb * 10).rounded() / 10),
         "signal_buffers": signalBuffers, "noise_buffers": noiseBuffers]
    }

    /// Float32 in → Float32 mono out (nil for other sample formats; the caller drops the buffer).
    func process(_ src: AVAudioPCMBuffer, into format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let n = Int(src.frameLength)
        let c = Int(src.format.channelCount)
        guard c > 0, n > 0, let chans = src.floatChannelData,
              let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(n)),
              let dst = out.floatChannelData?[0] else { return nil }
        if channelEma.count != c { reset(channels: c) }
        let interleaved = src.format.isInterleaved
        @inline(__always) func sample(_ k: Int, _ i: Int) -> Float { interleaved ? chans[0][i * c + k] : chans[k][i] }

        // 1. Loudest channel, with hysteresis so a capsule that is 0.5 dB louder this buffer
        //    does not make the track flip back and forth.
        if c > 1 {
            for k in 0..<c {
                var s: Double = 0
                for i in 0..<n { let v = sample(k, i); s += Double(v * v) }
                let rms = Float(sqrt(s / Double(n)))
                channelEma[k] = channelEma[k] == 0 ? rms : channelEma[k] * 0.7 + rms * 0.3
            }
            var best = channel
            for k in 0..<c where channelEma[k] > channelEma[best] * 1.41 { best = k }
            // Only re-pick on signal: in silence the capsules' noise floors differ by a few dB
            // and the pick would flip back and forth for nothing.
            if best != channel, channelEma[best] > max(floor, 1e-5) * Self.signalOverFloor {
                channelSwitches += 1
                if channelSwitches <= 5 || channelSwitches % 50 == 0 {
                    rlog(String(format: "mic: channel %d → %d (rms %@)", channel + 1, best + 1,
                                channelEma.map { String(format: "%.0f", LevelMeter.db($0)) }.joined(separator: "/")))
                }
                channel = best
            }
        }

        // 2. Buffer stats of the picked channel.
        var peak: Float = 0, sum: Double = 0
        for i in 0..<n { let v = sample(channel, i); let a = abs(v); if a > peak { peak = a }; sum += Double(v * v) }
        let rms = Float(sqrt(sum / Double(n)))

        // 3. Noise floor: follows the quietest buffers, creeps up slowly (~+0.2 dB per buffer).
        if floor < 0 { floor = max(rms, 1e-5) } else { floor = max(min(floor * 1.02, rms), 1e-5) }
        let isSignal = rms > floor * Self.signalOverFloor
        if isSignal { signalBuffers += 1; signalRun += 1 } else { noiseBuffers += 1; signalRun = 0 }

        // 4. Gain: from a peak tracker that only signal buffers feed (silence must not pump the
        //    gain up); attack instant, release 24 dB/s, never below 1. The tracker decays only
        //    0.05 dB per signal buffer: after real speech at a healthy level, clicks and breaths
        //    in the pauses cannot ratchet the gain up (0.3.2 measured +24 dB on keyboard noise
        //    in a quiet room — the next word would have clipped). A genuinely quieter source
        //    still converges fast, because the tracker starts at that low level.
        if isSignal {
            peakTrack = max(peak, peakTrack * 0.995)
            let wanted = min(maxGain, max(1, Self.targetPeak / max(peakTrack, 1e-6)))
            if wanted < gain { gain = wanted }                                                   // attack: always, at once
            else if signalRun >= Self.riseAfterBuffers { gain = min(wanted, gain * Self.releasePerBuffer) }  // rise: sustained signal only
        }
        let target = isSignal ? gain : gain * Self.expanderGain

        // 5. Apply with a linear ramp from the last applied gain (no clicks at gate edges).
        let from = appliedGain
        let step = (target - from) / Float(n)
        var g = from
        for i in 0..<n {
            g += step
            let v = sample(channel, i) * g
            dst[i] = v > 0.98 ? 0.98 : (v < -0.98 ? -0.98 : v)
        }
        appliedGain = target
        let db = 20 * log10f(max(target, 1e-6))
        if isSignal { if signalBuffers == 1 { minGainDb = db; maxGainDb = db } else { minGainDb = min(minGainDb, db); maxGainDb = max(maxGainDb, db) } }
        out.frameLength = AVAudioFrameCount(n)
        return out
    }
}
