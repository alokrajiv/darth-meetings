import Foundation

/// 0.3.21 — when should the tray ease its screen capture?
///
/// 2026-09-30: a colleague's fanless MacBook Air sat at 100 % system GPU and thermal "fair" for
/// whole Teams calls while the tray captured her 2304×1472 px Teams window at 5 fps BGRA. The
/// eased capture (2 fps, 420v, no cursor, a shorter SCK queue) costs far less, and it is applied
/// LIVE to the running stream (`SCStream.updateConfiguration`) — never by starting a new part,
/// because a part with different stream parameters costs a full server re-encode.
///
/// This is the decision half, pure and clock-free (the caller passes `now`, in monotonic
/// seconds), unit-tested in `Tests/TrayLogicTests`. Fed by `RecordingController` from every
/// 10 s `resource_sample` (`isSample: true`) and from the thermal / low-power notifications
/// (`isSample: false`, immediate).
///
/// Rules (`Config` defaults):
/// - **Step down to `.eased` at once** on thermal ≥ fair, Low Power Mode, memory pressure ≥ warn,
///   or system GPU ≥ `gpuHighPct` (90 %) for `gpuHighSamples` (12) CONSECUTIVE real samples
///   (2 min at 10 s — samples are counted, not time: a notification tick never counts, a
///   sample with no GPU reading breaks the run).
/// - **Step down to `.audioOnly`** on thermal serious / critical — only with `allowAudioOnly`
///   (FALSE in 0.3.21: an audio-only part costs a server re-encode; the hook is kept, off).
/// - **Step up** only when the level's triggers have been clear for `clearSeconds` (5 min — a
///   single GPU sample ≥ 90 % is NOT clear, so the way out is stricter than the way in) AND the
///   current level has been held for `minDwellSeconds` (60 s).
/// - nil / unknown inputs ("unknown" thermal, no GPU reading) never trigger and never hold.
/// - Output only on a change (`Decision`). The mode (`CaptureProfileMode`) can pin it:
///   `.never` keeps `.normal`, `.eased` keeps `.eased`.
public enum CaptureLoad: String, CaseIterable, Comparable {
    case normal
    case eased
    /// Not produced while `Config.allowAudioOnly` is false (0.3.21 default).
    case audioOnly = "audio_only"

    var rank: Int { switch self { case .normal: return 0; case .eased: return 1; case .audioOnly: return 2 } }
    public static func < (a: CaptureLoad, b: CaptureLoad) -> Bool { a.rank < b.rank }
}

/// UserDefaults `captureProfileMode` (Settings ▸ Capture, ws `set_capture_profile_mode`).
public enum CaptureProfileMode: String, CaseIterable {
    /// The policy decides (default).
    case auto
    /// Every recording starts eased and stays eased.
    case eased
    /// The policy is ignored: always the normal capture.
    case never

    public static let `default`: CaptureProfileMode = .auto
    public init(stored: String?) { self = stored.flatMap(CaptureProfileMode.init(rawValue:)) ?? .default }
}

public struct CaptureEasePolicy {
    public struct Config: Equatable {
        public var gpuHighPct: Double = 90
        public var gpuHighSamples: Int = 12
        public var clearSeconds: Double = 5 * 60
        public var minDwellSeconds: Double = 60
        public var allowAudioOnly = false
        public init() {}

        /// ws `simulate_capture_pressure {fast: true}`: an E2E run in seconds, not 7 minutes.
        public static var fast: Config {
            var c = Config()
            c.gpuHighSamples = 2
            c.clearSeconds = 20
            c.minDwellSeconds = 5
            return c
        }
    }

    /// What the policy looks at. Every field may be unknown (nil).
    public struct Inputs: Equatable {
        /// "nominal" | "fair" | "serious" | "critical" (anything else = unknown).
        public var thermal: String?
        /// System-wide GPU utilisation, 0–100.
        public var gpuPct: Double?
        public var lowPower: Bool?
        /// "normal" | "warn" | "critical" (anything else = unknown).
        public var memPressure: String?
        public init(thermal: String? = nil, gpuPct: Double? = nil, lowPower: Bool? = nil, memPressure: String? = nil) {
            self.thermal = thermal; self.gpuPct = gpuPct; self.lowPower = lowPower; self.memPressure = memPressure
        }

        /// From a `ResourceSampler` sample dict (`thermal`, `gpu_pct`, `low_power`, `mem_pressure`).
        public init(sample s: [String: Any]) {
            thermal = s["thermal"] as? String
            gpuPct = (s["gpu_pct"] as? Double) ?? (s["gpu_pct"] as? Int).map(Double.init)
            lowPower = s["low_power"] as? Bool
            memPressure = s["mem_pressure"] as? String
        }

        /// All clear (ws `simulate_capture_pressure {clear: true}`).
        public static let clear = Inputs(thermal: "nominal", gpuPct: 0, lowPower: false, memPressure: "normal")

        /// Field-wise override: every non-nil field of `o` replaces this one's.
        public func overridden(by o: Inputs) -> Inputs {
            Inputs(thermal: o.thermal ?? thermal, gpuPct: o.gpuPct ?? gpuPct, lowPower: o.lowPower ?? lowPower,
                   memPressure: o.memPressure ?? memPressure)
        }

        /// `{thermal, gpu_pct, low_power, mem_pressure}` for an event; unknown = JSON null.
        public var json: [String: Any] {
            ["thermal": thermal ?? NSNull(), "gpu_pct": gpuPct ?? NSNull(), "low_power": lowPower ?? NSNull(),
             "mem_pressure": memPressure ?? NSNull()]
        }

        var thermalElevated: Bool { ["fair", "serious", "critical"].contains(thermal ?? "") }
        var thermalSevere: Bool { ["serious", "critical"].contains(thermal ?? "") }
        var memElevated: Bool { ["warn", "critical"].contains(memPressure ?? "") }
    }

    public struct Tick {
        public var now: Double
        public var inputs: Inputs
        /// A real 10 s sample (its GPU reading counts toward the run). False for a notification
        /// tick (thermal / power state changed): only thermal, low power and memory are judged.
        public var isSample: Bool
        public init(now: Double, inputs: Inputs, isSample: Bool = true) {
            self.now = now; self.inputs = inputs; self.isSample = isSample
        }
    }

    public struct Decision: Equatable {
        public var from: CaptureLoad
        public var to: CaptureLoad
        /// "thermal_fair" | "thermal_serious" | "low_power" | "mem_pressure_warn" | "gpu_sustained"
        /// (joined with "+" when several hold), "clear" on a step up, "mode_eased" / "mode_never"
        /// / "mode_auto" for a mode change, "forced".
        public var reason: String
        public var values: Inputs
    }

    public var config: Config
    public init(config: Config = Config()) { self.config = config }

    public private(set) var mode: CaptureProfileMode = .auto
    public private(set) var current: CaptureLoad = .normal
    /// Consecutive real samples with GPU ≥ `gpuHighPct`.
    public private(set) var gpuHighStreak = 0
    /// Number of decisions returned since `begin`.
    public private(set) var changes = 0
    public private(set) var lastInputs = Inputs()
    private var lastChangeAt = 0.0
    /// Last time anything asked for ≥ eased / ≥ audio-only.
    private var lastMildAt: Double?
    private var lastSevereAt: Double?
    /// After a failed apply: no new step down before this (an SCK that refuses the update is
    /// not asked again every 10 s).
    private var holdUntil: Double?

    /// What a recording should START with — no live change needed. GPU cannot trigger here
    /// (it needs a run of samples); never `.audioOnly` (a recording's audio-only start is the
    /// call profile's business, not this policy's).
    public func startingProfile(for inputs: Inputs) -> CaptureLoad {
        switch mode {
        case .never: return .normal
        case .eased: return .eased
        case .auto: return Self.instantTriggers(inputs).isEmpty ? .normal : .eased
        }
    }

    /// A new recording: state reset, `startingProfile` taken as the current level.
    @discardableResult
    public mutating func begin(at now: Double, mode: CaptureProfileMode, inputs: Inputs) -> CaptureLoad {
        self.mode = mode
        gpuHighStreak = 0; changes = 0; holdUntil = nil
        lastInputs = inputs
        current = startingProfile(for: inputs)
        lastChangeAt = now
        lastMildAt = current >= .eased ? now : nil
        lastSevereAt = nil
        return current
    }

    /// The triggers that act on a single reading (everything but the GPU run).
    public static func instantTriggers(_ i: Inputs) -> [String] {
        var r: [String] = []
        if i.thermalElevated { r.append("thermal_\(i.thermal!)") }
        if i.lowPower == true { r.append("low_power") }
        if i.memElevated { r.append("mem_pressure_\(i.memPressure!)") }
        return r
    }

    public mutating func tick(_ k: Tick) -> Decision? {
        let i = k.inputs
        lastInputs = i
        if k.isSample {
            if let g = i.gpuPct, g >= config.gpuHighPct { gpuHighStreak += 1 } else { gpuHighStreak = 0 }
        }
        guard mode == .auto else { return nil }
        var triggers = Self.instantTriggers(i)
        if gpuHighStreak >= config.gpuHighSamples { triggers.append("gpu_sustained") }
        // A single high GPU sample is not "clear" (hysteresis: in after 12, out after 5 min of none).
        let gpuHot = k.isSample && (i.gpuPct.map { $0 >= config.gpuHighPct } ?? false)
        if !triggers.isEmpty || gpuHot { lastMildAt = k.now }
        let severe = config.allowAudioOnly && i.thermalSevere
        if severe { lastSevereAt = k.now }

        let wanted: CaptureLoad = severe ? .audioOnly : (triggers.isEmpty ? .normal : .eased)
        if wanted > current {
            if let h = holdUntil, k.now < h { return nil }
            return change(to: wanted, reason: triggers.joined(separator: "+"), now: k.now)
        }
        guard current > .normal, k.now - lastChangeAt >= config.minDwellSeconds else { return nil }
        // Step up as far as the clear windows allow.
        var target = current
        if target == .audioOnly, lastSevereAt.map({ k.now - $0 >= config.clearSeconds }) ?? true { target = .eased }
        if target == .eased, lastMildAt.map({ k.now - $0 >= config.clearSeconds }) ?? true { target = .normal }
        guard target != current else { return nil }
        return change(to: target, reason: "clear", now: k.now)
    }

    private mutating func change(to: CaptureLoad, reason: String, now: Double) -> Decision {
        let d = Decision(from: current, to: to, reason: reason, values: lastInputs)
        current = to
        lastChangeAt = now
        holdUntil = nil
        changes += 1
        return d
    }

    /// The mode changed mid-recording: `.eased` / `.never` pin the level at once; `.auto` hands
    /// it back to the rules (from the current level, dwell counted from now).
    public mutating func setMode(_ m: CaptureProfileMode, now: Double) -> Decision? {
        guard m != mode else { return nil }
        mode = m
        switch m {
        case .eased:
            lastMildAt = now
            return current == .eased ? nil : change(to: .eased, reason: "mode_eased", now: now)
        case .never:
            return current == .normal ? nil : change(to: .normal, reason: "mode_never", now: now)
        case .auto:
            lastChangeAt = now
            return nil
        }
    }

    /// ws `force_capture_profile`: take `to` as the current level (the rules carry on from it).
    public mutating func force(_ to: CaptureLoad, now: Double) -> Decision? {
        guard to != current else { return nil }
        if to >= .eased { lastMildAt = now }
        return change(to: to, reason: "forced", now: now)
    }

    /// The controller could not apply `d` (SCK refused the update): back to `d.from`, and no
    /// new step down for `minDwellSeconds`.
    public mutating func applyFailed(_ d: Decision, now: Double) {
        current = d.from
        lastChangeAt = now
        holdUntil = now + config.minDwellSeconds
    }
}
