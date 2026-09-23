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
///    usually a different sample rate), so the tap and the conditioner's mono format come from
///    `outputFormat(forBus: 0)` re-read AFTER enabling, never from the hardware format we
///    looked at first. The raw path still reads `inputFormat(forBus: 0)` and still folds > 2
///    channels to mono the 0.3.1 way.
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
///
/// **Devices (0.3.16).** On 2026-09-23 11:04 SGT the AirPods left a Meet recording twenty
/// seconds in and the mic track stayed empty for the remaining 33 minutes: the engine had
/// started on the AirPods, stopped when they went, and nothing started it again — 212 buffers,
/// "mic ✗" on the health line for half an hour, the MacBook's own mic never asked. Alok:
/// *"when audio device changes and shit — it doesn't detect"*, and the gear offered neither a
/// re-detect nor a manual pick. So:
///
/// - **The writer's format is fixed.** Whatever the device, `format` is 48 kHz mono Float32
///   (`canonicalRate`); the tap converts (`AVAudioConverter`) when the device runs at another
///   rate (AirPods in their voice mode: 24 kHz). The mic track spec no longer depends on the
///   device, so a device swap mid-part cannot hand the AAC input a rate it was not built for.
/// - **Device pick.** `deviceUID == nil` means the system default input, followed as it
///   changes; a UID pins one device (`kAudioOutputUnitProperty_CurrentDevice` on the input
///   unit, set AFTER voice processing is enabled because enabling rebuilds that unit). A pinned
///   device that is absent falls back to the default and is picked up again when it returns.
/// - **Restart, three triggers.** (a) `AVAudioEngineConfigurationChange` — the engine stopped
///   because its device changed; (b) CoreAudio says the default input or the device list
///   changed and the device we WANT is no longer the one we are on; (c) the watchdog: no buffer
///   for 3 s, or the engine not running, checked every second (the 11:04 case had no
///   notification worth the name). Each restart is a fresh engine on the same path as `start`,
///   `format` unchanged so `onBuffer` and the writer's track stay wired, cumulative counters
///   kept, and `mic_restarted` in the event log with from/to device. Restarts are at least 5 s
///   apart.
final class MicCapture {
    /// What this capture's microphone ACTUALLY ran with (not what was asked for).
    /// `.unavailable` = asked for, refused by the system, running raw.
    enum VoiceProcessing: String { case on, off, unavailable }

    /// The mic track's sample rate in the file — the same for every device (0.3.16).
    static let canonicalRate: Double = 48_000
    /// Watchdog: no buffer for this long (with the engine supposedly running) → restart.
    static let stallSeconds: TimeInterval = 3
    /// Never two restarts closer than this (a loop guard, not a tempo — the loop that needed
    /// it was a bookkeeping bug, fixed the same day).
    static let restartSpacing: TimeInterval = 2
    /// A CoreAudio device event is the FIRST of a burst (the default flips, the old device's
    /// streams go, voice processing rebuilds its aggregate): wait for the dust before a restart.
    static let deviceEventSettle: TimeInterval = 1.0

    private var engine = AVAudioEngine()
    private var tapped = false
    /// `start()` succeeded and `stop()` has not been called: the watchers and the watchdog
    /// are allowed to restart the engine.
    private var live = false
    /// Bumped per engine, so a tap callback from an engine we threw away is ignored.
    private var generation = 0
    /// The format of the buffers handed to `onBuffer` — always `canonicalRate` Hz mono (0.3.16).
    private(set) var format: AVAudioFormat?
    /// What the node reported when the tap was installed (the hardware format on the raw path,
    /// the voice-processing output format when that is on).
    private(set) var hardwareFormat: AVAudioFormat?
    private var reduce = false
    private(set) var reduceDropped = 0
    private(set) var convertDropped = 0
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

    // 0.3.16: device pick + self-healing.
    /// nil = the system default input, followed as it changes.
    private(set) var deviceUID: String?
    /// The device the running engine is actually on.
    private(set) var deviceID: AudioDeviceID?
    private(set) var deviceName: String?
    /// What the input unit itself reports as its device — the truth on the raw AUHAL path
    /// (the self-test proves a pin with it), the OUTPUT device under voice processing (useless).
    private(set) var unitDeviceID: AudioDeviceID?
    /// True when a pinned device was absent and the default is standing in.
    private(set) var deviceFallback = false
    private(set) var restarts = 0
    private(set) var lastRestartReason: String?
    private var lastRestartAt = Date.distantPast
    private var watcher: AudioDevices.Watcher?
    private var configObserver: NSObjectProtocol?
    private var watchdog: Timer?
    private var restartPending: DispatchWorkItem?
    private let bufferLock = NSLock()
    private var lastBufferAtLocked = Date.distantPast
    private var lastBufferAt: Date {
        get { bufferLock.lock(); defer { bufferLock.unlock() }; return lastBufferAtLocked }
        set { bufferLock.lock(); lastBufferAtLocked = newValue; bufferLock.unlock() }
    }
    /// Main queue, after every successful restart: (from device, to device, reason).
    var onRestarted: ((String?, String?, String) -> Void)?

    // 0.3.16: gap filling — the end (pts + duration) of the last buffer handed to `onBuffer`,
    // tap thread only (taps of successive engines never overlap: the old tap is removed
    // before the new engine starts).
    private var lastEnd: CMTime = .invalid
    /// Gaps shorter than this are the tap's own jitter; longer than the max is a clock jump.
    static let gapFillMin: Double = 0.25
    static let gapFillMax: Double = 600
    private(set) var gapFilledSeconds: Double = 0
    private(set) var gapsFilled = 0

    /// Silence from `from` to `to` on the writer's format, in ≤ 1 s pieces, through `onBuffer`.
    private func fillGap(from: CMTime, to: CMTime, format: AVAudioFormat) {
        let total = CMTimeSubtract(to, from).seconds
        var at = from
        var left = CMTimeSubtract(to, from)
        while left.seconds > 0.001 {
            let frames = AVAudioFrameCount(min(left.seconds, 1.0) * Self.canonicalRate)
            guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { break }
            buf.frameLength = frames   // zero-filled
            guard let sb = MicCapture.sampleBuffer(from: buf, pts: at) else { break }
            onBuffer?(sb)
            let d = CMTime(value: CMTimeValue(frames), timescale: CMTimeScale(Self.canonicalRate))
            at = CMTimeAdd(at, d)
            left = CMTimeSubtract(left, d)
        }
        gapsFilled += 1
        gapFilledSeconds += total
        rlog(String(format: "mic: filled a %.2f s gap with silence (gap %d, %.1f s in all) — the mic track stays in step with the system track", total, gapsFilled, gapFilledSeconds))
    }

    init(voiceProcessing: Bool = false, deviceUID: String? = nil) {
        wantsVoiceProcessing = voiceProcessing
        self.deviceUID = deviceUID
    }

    /// `true | false | "unavailable"` for the event log and the ws payloads.
    var voiceProcessingJSON: Any { voiceProcessing == .unavailable ? "unavailable" : (voiceProcessing == .on) }
    /// "48000 Hz × 1 ch" — the format the writer's mic track was built from.
    var formatLabel: String? { format.map { "\(Int($0.sampleRate)) Hz × \($0.channelCount) ch" } }
    var hardwareFormatLabel: String? { hardwareFormat.map { "\(Int($0.sampleRate)) Hz × \($0.channelCount) ch" } }
    /// "MacBook Pro Microphone (default)" / "Alok's AirPods Pro 3" / "MacBook Pro Microphone (standing in for …)".
    var deviceLabel: String? {
        guard let deviceName else { return nil }
        if deviceUID == nil { return "\(deviceName) (default)" }
        if deviceFallback { return "\(deviceName) (standing in — the chosen microphone is not connected)" }
        return pinnedRaw ? "\(deviceName) (chosen — echo cancellation off)" : "\(deviceName) (chosen)"
    }
    var deviceJSON: [String: Any] {
        ["mode": deviceUID == nil ? "auto" : "manual", "uid": deviceUID ?? NSNull(),
         "name": deviceName ?? NSNull(), "fallback": deviceFallback, "pinned_raw": pinnedRaw, "restarts": restarts,
         "gaps_filled": gapsFilled, "gap_filled_s": Double((gapFilledSeconds * 10).rounded() / 10),
         "last_restart_reason": lastRestartReason ?? NSNull()]
    }

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
    /// still succeeds — on the raw path. Main queue (the watchers and the watchdog live there).
    func start() throws {
        guard !tapped else { return }
        try startWithFallback()
        live = true
        armWatchers()
    }

    /// Voice processing for THIS start: what was asked for, unless a specific microphone is
    /// pinned and present — Apple's voice-processing unit takes its input from the system
    /// default whatever `CurrentDevice` is set to (probed on Global/0, Global/1, Input/1 and
    /// Output/0, self-test 2026-09-23: the hardware format never left the MacBook mic), so a
    /// pin can only be honoured by the plain AUHAL path. Echo cancellation is off while pinned;
    /// the menu says so.
    private var effectiveVoiceProcessing: Bool {
        guard wantsVoiceProcessing else { return false }
        if deviceUID != nil, !wantedDevice().fallback { return false }
        return true
    }
    /// True when voice processing was asked for and set aside for a pinned device.
    var pinnedRaw: Bool { wantsVoiceProcessing && voiceProcessing == .off && deviceUID != nil && !deviceFallback }

    private func startWithFallback() throws {
        let vp = effectiveVoiceProcessing
        if wantsVoiceProcessing, !vp { rlog("mic: a specific microphone is pinned — voice processing (echo cancellation) is off for this capture") }
        do {
            try startEngine(voiceProcessing: vp)
            voiceProcessing = vp ? .on : .off
        } catch {
            guard vp else { throw error }
            rlog("mic: voice processing unavailable — raw input (\(error.localizedDescription))")
            EventLog.shared.log("mic_voice_processing_unavailable", ["error": error.localizedDescription])
            // A half-configured voice-processing IO unit is not reusable: start over on a
            // brand-new engine so the retry is a genuine raw path.
            resetEngine(keepStats: false)
            try startEngine(voiceProcessing: false)
            voiceProcessing = .unavailable
        }
    }

    private func resetEngine(keepStats: Bool) {
        if tapped { engine.inputNode.removeTap(onBus: 0); tapped = false }
        engine.stop()
        // Let the old engine die off the main thread: its dealloc blocks on its own queue,
        // and that queue can be busy telling us about the change we are reacting to.
        let old = engine
        engine = AVAudioEngine()
        DispatchQueue.global(qos: .utility).async { _ = old }
        generation += 1
        if !keepStats {
            buffersSeen = 0
            reduceDropped = 0
            convertDropped = 0
            peak = 0
        }
    }

    /// The device this capture should be on right now: the pinned one when present, else the
    /// system default. `fallback` says a pinned device was asked for and is absent.
    private func wantedDevice() -> (id: AudioDeviceID?, fallback: Bool) {
        if let uid = deviceUID {
            if let id = AudioDevices.id(forUID: uid) { return (id, false) }
            return (AudioDevices.defaultInputID, true)
        }
        return (AudioDevices.defaultInputID, false)
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
        // 0.3.16: put the chosen device on the input unit — after voice processing had its
        // say (it swaps the unit), before any format is read (the format is the device's).
        let wanted = wantedDevice()
        deviceFallback = wanted.fallback
        if let uid = deviceUID, wanted.fallback {
            rlog("mic: chosen microphone \(uid) is not connected — using the system default for now")
        }
        if let id = wanted.id, deviceUID != nil, !wanted.fallback {
            if let unit = input.audioUnit {
                do { try AudioDevices.setDevice(id, on: unit) }
                catch { rlog("mic: \(error.localizedDescription) — staying on the system default"); deviceFallback = true }
            } else {
                rlog("mic: input node has no audio unit yet — cannot pin a device, using the system default")
                deviceFallback = true
            }
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
        // The conditioner writes Float32 mono at the device's rate; the writer always gets
        // Float32 mono at the canonical rate (0.3.16), converted here when they differ.
        guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hw.sampleRate, channels: 1, interleaved: false),
              let canon = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.canonicalRate, channels: 1, interleaved: false) else {
            throw NSError(domain: "mic", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not build a mono format at \(Int(hw.sampleRate)) Hz"])
        }
        let converter: AVAudioConverter?
        if hw.sampleRate != Self.canonicalRate {
            guard let c = AVAudioConverter(from: mono, to: canon) else {
                throw NSError(domain: "mic", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not build a \(Int(hw.sampleRate)) → \(Int(Self.canonicalRate)) Hz converter"])
            }
            converter = c
        } else {
            converter = nil
        }
        let ratio = Self.canonicalRate / hw.sampleRate
        reduce = hw.channelCount > 1
        if reduce { rlog("mic: hardware format \(fmt(hw)) — mono track = loudest channel + AGC") }
        format = canon
        conditioner.reset(channels: Int(hw.channelCount))
        // Two AGCs chasing each other is worse than none: Apple's stays, ours is capped.
        conditioner.setMaxGainDb(voiceProcessing ? Self.agcCapWithVoiceProcessingDb : Self.agcCapRawDb)
        let gen = generation
        // The tap must use the node's own format; the conversion happens in the callback.
        input.installTap(onBus: 0, bufferSize: 2048, format: hw) { [weak self] raw, when in
            guard let self, self.generation == gen else { return }
            self.buffersSeen += 1
            self.lastBufferAt = Date()
            guard let conditioned = self.conditioner.process(raw, into: mono) else {
                self.reduceDropped += 1
                if self.reduceDropped == 1 { rlog("mic: could not condition a \(raw.format.channelCount) ch buffer (\(raw.format.commonFormat.rawValue)) — dropping") }
                return
            }
            var buf = conditioned
            if let converter {
                guard let out = AVAudioPCMBuffer(pcmFormat: canon, frameCapacity: AVAudioFrameCount(Double(conditioned.frameLength) * ratio) + 32) else { return }
                var fed = false
                var err: NSError?
                let st = converter.convert(to: out, error: &err) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true; status.pointee = .haveData; return conditioned
                }
                if st == .error || out.frameLength == 0 {
                    self.convertDropped += 1
                    if self.convertDropped == 1 { rlog("mic: \(Int(hw.sampleRate)) → \(Int(Self.canonicalRate)) Hz conversion failed (\(err?.localizedDescription ?? "no frames")) — dropping") }
                    return
                }
                buf = out
            }
            if let m = LevelMeter.measure(buf) {
                self.peak = max(self.peak, m.peak)
                self.meter.note(peak: m.peak, rms: m.rms)
            }
            if self.buffersSeen == 1 {
                rlog("mic: first buffer \(Int(Date().timeIntervalSince(self.startedAt) * 1000)) ms after start — \(fmt(raw.format)), \(raw.frameLength) frames\(converter == nil ? "" : " → \(buf.frameLength) @ \(Int(Self.canonicalRate)) Hz")")
            }
            let pts = MicCapture.hostPTS(when)
            // The writer packs audio samples back to back: a restart's outage would simply
            // vanish from the mic track and everything after it would sit early against the
            // system track (E2E 2026-09-23: 21.5 s of mic in a 34 s recording). Fill it.
            if self.lastEnd.isValid {
                let gap = CMTimeSubtract(pts, self.lastEnd).seconds
                if gap > Self.gapFillMin, gap < Self.gapFillMax {
                    self.fillGap(from: self.lastEnd, to: pts, format: canon)
                }
            }
            self.lastEnd = CMTimeAdd(pts, CMTime(value: CMTimeValue(buf.frameLength), timescale: CMTimeScale(Self.canonicalRate)))
            guard let sb = MicCapture.sampleBuffer(from: buf, pts: pts) else { return }
            self.onBuffer?(sb)
        }
        tapped = true
        startedAt = Date()
        lastBufferAt = Date()
        engine.prepare()
        do {
            try engine.start()
        } catch {
            // Leave nothing behind for the raw retry to trip over.
            input.removeTap(onBus: 0)
            tapped = false
            throw error
        }
        // What we are on: the pick, or the default input at this moment (a fresh engine's
        // input node opens on the default). NOT read off the unit — the voice-processing unit
        // answers `CurrentDevice` with its OUTPUT device ("MacBook Pro Speakers", self-test
        // 2026-09-23), and that wrong answer made every device-list event look like a mismatch
        // and restart the engine every 5 s for as long as it ran.
        deviceID = wanted.id
        deviceName = deviceID.flatMap { AudioDevices.name(of: $0) } ?? AVCaptureDevice.default(for: .audio)?.localizedName
        unitDeviceID = input.audioUnit.flatMap { AudioDevices.currentDevice(of: $0) }
        let unitSays = unitDeviceID.flatMap { AudioDevices.name(of: $0) }
        rlog("mic: capturing \(fmt(hw)) from \(deviceLabel ?? "default input") (unit reports \(unitSays ?? "?"))\(reduce ? " → mono track" : "")"
             + (converter == nil ? "" : " → \(Int(Self.canonicalRate)) Hz")
             + " · voice processing \(voiceProcessing ? "ON" : "off") · AGC cap \(Int(voiceProcessing ? Self.agcCapWithVoiceProcessingDb : Self.agcCapRawDb)) dB")
    }

    private func fmt(_ f: AVAudioFormat) -> String { "\(Int(f.sampleRate)) Hz × \(f.channelCount) ch" }

    // MARK: 0.3.16 — device changes + self-healing

    private func armWatchers() {
        watcher = AudioDevices.Watcher { [weak self] what in self?.devicesChanged(what) }
        // `queue: nil` — delivered on the engine's own queue, and we hop to main ourselves.
        // With `queue: .main` NotificationCenter WAITS for main to run the block, and the
        // engine's queue posts this notification while main may be releasing that very engine
        // (`AVAudioEngine.dealloc` does a dispatch_sync onto the engine queue): both wait for
        // each other for good (sampled 2026-09-23 12:34, self-test frozen at restart 1).
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
            guard let e = note.object as? AVAudioEngine else { return }
            let running = e.isRunning
            DispatchQueue.main.async { [weak self] in
                guard let self, e === self.engine else { return }
                // The voice-processing unit posts one of these ~100 ms after EVERY start,
                // engine still running (self-test 2026-09-23). Only a stopped engine needs a
                // restart; the watchdog has the rest.
                guard !running else { rlog("mic: engine configuration changed, still running — leaving it"); return }
                rlog("mic: engine configuration changed and the engine stopped — restarting")
                self.scheduleRestart(reason: "engine stopped on a configuration change")
            }
        }
        watchdog?.invalidate()
        watchdog = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.watchdogTick() }
        watchdog?.tolerance = 0.2
    }

    private func disarmWatchers() {
        watcher = nil
        if let o = configObserver { NotificationCenter.default.removeObserver(o); configObserver = nil }
        watchdog?.invalidate(); watchdog = nil
        restartPending?.cancel(); restartPending = nil
    }

    /// CoreAudio: the default input or the device list changed. Only a change that moves the
    /// device we WANT away from the one we are on is worth a restart — a Bluetooth headset
    /// appearing while a pinned MacBook mic records is not.
    private func devicesChanged(_ what: String) {
        guard live else { return }
        // A restart is in its gap: the start that follows reads the wanted device then, so
        // this event is already covered (otherwise every swap cost two restarts — self-test).
        if starting { rlog("mic: \(what) changed during a restart — the pending start will pick it up"); return }
        let wanted = wantedDevice()
        let wantedName = wanted.id.flatMap { AudioDevices.name(of: $0) } ?? "none"
        if wanted.id == deviceID, wanted.fallback == deviceFallback {
            rlog("mic: \(what) changed — still on \(deviceName ?? "?"), nothing to do")
            return
        }
        rlog("mic: \(what) changed — wanted \(wantedName)\(wanted.fallback ? " (standing in)" : ""), on \(deviceName ?? "?") — restarting")
        scheduleRestart(reason: "\(what == "default_input" ? "default input" : "device list") changed → \(wantedName)", after: Self.deviceEventSettle)
    }

    /// Every second: the engine is not running, or no buffer for `stallSeconds` → restart.
    /// This is the trigger that would have saved the 2026-09-23 recording.
    private func watchdogTick() {
        guard live, restartPending == nil, !starting else { return }
        let silentFor = Date().timeIntervalSince(lastBufferAt)
        if !engine.isRunning {
            scheduleRestart(reason: "engine not running")
        } else if silentFor >= Self.stallSeconds {
            scheduleRestart(reason: "no mic buffers for \(Int(silentFor)) s")
        }
    }

    /// Debounced (`after` — device changes come in bursts) and spaced (≥ `restartSpacing`).
    private func scheduleRestart(reason: String, after: TimeInterval = 0.4) {
        guard live else { return }
        restartPending?.cancel()
        let since = Date().timeIntervalSince(lastRestartAt)
        let delay = max(after, Self.restartSpacing - since)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.restartPending = nil
            self.restart(reason: reason)
        }
        restartPending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Tear the engine down now and bring it up again `restartGap` later on whatever device is
    /// wanted then. The gap is not cosmetic: an engine started in the same instant the old one
    /// is torn down comes up dead or stops once more within ~200 ms (self-test 2026-09-23:
    /// every back-to-back restart, both paths — the old engine's aggregate device is still
    /// being dismantled). Counters and the meter carry on; `format` is unchanged so the
    /// writer's track stays valid. Returns false only when nothing is live to restart.
    static let restartGap: TimeInterval = 1.0
    private var starting = false

    @discardableResult
    func restart(reason: String) -> Bool {
        guard live else { return false }
        let from = deviceName
        let before = buffersSeen
        restarts += 1
        lastRestartAt = Date()
        lastRestartReason = reason
        let attempt = restarts
        resetEngine(keepStats: true)
        starting = true
        rlog("mic: restart \(attempt) (\(reason)) — engine down, up again in \(Self.restartGap) s")
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.restartGap) { [weak self] in
            guard let self, self.live, self.starting, self.restarts == attempt else { return }
            self.starting = false
            self.lastRestartAt = Date()
            do {
                try self.startWithFallback()
            } catch {
                rlog("mic: restart \(attempt) (\(reason)) FAILED — \(error.localizedDescription); the watchdog will try again")
                EventLog.shared.log("mic_restart_failed", ["reason": reason, "restarts": attempt, "error": error.localizedDescription, "from": from ?? NSNull()])
                return
            }
            // Only the first few and then every 12th, in case a dead device keeps the watchdog busy.
            let payload: [String: Any] = ["reason": reason, "restarts": attempt, "from": from ?? NSNull(), "to": self.deviceName ?? NSNull(),
                                          "buffers_before": before, "device": self.deviceJSON, "processing": self.voiceProcessingJSON]
            if attempt <= 3 || attempt % 12 == 0 {
                EventLog.shared.log("mic_restarted", payload, summary: "mic: restarted (\(reason)) — \(from ?? "?") → \(self.deviceName ?? "?"), restart \(attempt), \(before) buffers so far")
            } else {
                rlog("mic: restarted (\(reason)) — \(from ?? "?") → \(self.deviceName ?? "?"), restart \(attempt)")
            }
            self.onRestarted?(from, self.deviceName, reason)
        }
        return true
    }

    /// The person picked a microphone (nil = back to the system default). Restarts at once
    /// when live; otherwise just remembered for `start()`.
    func switchDevice(uid: String?) -> String {
        deviceUID = uid
        guard live else { return "remembered" }
        restartPending?.cancel(); restartPending = nil
        lastRestartAt = .distantPast
        let target: String
        if let uid {
            target = AudioDevices.id(forUID: uid).flatMap { AudioDevices.name(of: $0) } ?? uid
        } else {
            target = "\(AudioDevices.defaultInputID.flatMap { AudioDevices.name(of: $0) } ?? "system default") (default)"
        }
        let ok = restart(reason: uid == nil ? "picked: system default" : "picked: \(target)")
        return ok ? target : "could not start the microphone"
    }

    /// Self-test only: kill the engine behind the capture's back, the way a vanished device
    /// does, and leave the watchdog to notice.
    func _testStopEngine() { engine.stop() }

    func stop() {
        disarmWatchers()
        live = false
        guard tapped else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        tapped = false
        // Same as `resetEngine`: the engine's last reference must not drop on the main thread.
        let old = engine
        engine = AVAudioEngine()
        DispatchQueue.global(qos: .utility).async { _ = old }
        rlog("mic: stopped after \(buffersSeen) buffers, peak \(String(format: "%.3f", peak)) — vp=\(voiceProcessing.rawValue) — restarts \(restarts) — \(conditioner.summary)")
    }

    /// The tap's AVAudioTime on the host clock — the clock SCK uses, so the tracks line up
    /// without any offset bookkeeping.
    static func hostPTS(_ when: AVAudioTime) -> CMTime {
        when.isHostTimeValid ? CMClockMakeHostTimeFromSystemUnits(when.hostTime) : CMClockGetTime(CMClockGetHostTimeClock())
    }

    static func sampleBuffer(from buf: AVAudioPCMBuffer, when: AVAudioTime) -> CMSampleBuffer? {
        sampleBuffer(from: buf, pts: hostPTS(when))
    }

    /// AVAudioPCMBuffer at an explicit presentation time → CMSampleBuffer.
    static func sampleBuffer(from buf: AVAudioPCMBuffer, pts: CMTime) -> CMSampleBuffer? {
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
