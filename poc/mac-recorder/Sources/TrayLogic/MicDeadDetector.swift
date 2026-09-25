/// 0.3.18 — is the microphone DEAD during a recording?
///
/// 2026-09-25 16:05 SGT: a 48-minute Teams call's mic track read −120 dB / peak 0.000 for
/// 2684 s because the Microphone menu had been switched to "Microsoft Teams Audio" (a loopback
/// driver that delivers digital silence), while the system track was audible throughout. The
/// only signal was "mic ✗" in a banner that hides itself after 10 s. This is the decision
/// half of the fix: fed once a second by `RecordingController.healthTick`, it says when a
/// recording's mic is dead. The controller and the app decide what to DO (fall back to
/// Automatic, re-detect, a banner that stays).
///
/// Pure and clock-free (the caller passes `t`), so every rule is unit-tested
/// (`Tests/TrayLogicTests`).
///
/// Two ways a mic is dead:
/// - **digital silence** — buffers keep arriving, but not one of them peaked above
///   `zeroFloorDb` (−100 dBFS) for `zeroSeconds` (15 s). A real capsule always has a noise
///   floor well above that; only a device that produces nothing reads like this.
/// - **silent while the call is audible** — no audible mic second (RMS > −60 dBFS) for
///   `quietSeconds` (60 s), the SYSTEM track audible for at least `quietSystemFraction` of
///   that minute (a conversation is happening), and not a single mic buffer peaked above
///   `quietMicPeakCeilingDb` (−60 dBFS) in the window. The last guard is ours, not the brief's:
///   someone listening quietly to a long monologue still has a room — a cough, a keyboard — and
///   an automatic switch away from a mic they chose is not a cheap false positive.
///
/// Never while the user muted the mic, never on a mic track the recording does not have,
/// never inside `graceSeconds` of a mic (re)start (the windows are counted from the end of the
/// grace), at most once per `cooldownSeconds`. A re-detect in automatic mode arms a follow-up
/// `followUpSeconds` later that fires once more if the mic is still dead ("pick a microphone";
/// by the digital-silence rule, or nothing from the mic for `followUpQuietSeconds` while the
/// system track stayed audible for `quietSystemFraction` of the time since the re-detect);
/// after a follow-up the detector stays quiet until the mic recovers or `backoffSeconds` pass,
/// so a mic that cannot be fixed from here does not nag every two minutes for an hour.
public struct MicDeadDetector {
    public struct Config {
        public var zeroFloorDb: Float = -100
        public var zeroSeconds: Double = 15
        public var quietSeconds: Double = 60
        public var quietSystemFraction: Double = 2.0 / 3.0
        public var quietMicPeakCeilingDb: Float = -60
        public var audibleDb: Float = -60
        public var graceSeconds: Double = 5
        public var cooldownSeconds: Double = 120
        public var followUpSeconds: Double = 30
        /// Follow-up "still dead" for the quiet reason: no audible mic and no peak above the
        /// ceiling for this long since the re-detect's grace ended.
        public var followUpQuietSeconds: Double = 20
        public var backoffSeconds: Double = 600
        public init() {}
    }

    /// One observation, once a second.
    public struct Tick {
        /// Monotonic seconds (any origin).
        public var t: Double
        /// Recording, the recording has a mic track, and a mic capture exists.
        public var active: Bool
        /// The user switched the mic off (0.3.17 Audio menu) — silence on purpose.
        public var muted: Bool
        /// `MicCapture.restarts` — a change means a new engine: the grace starts again.
        public var micRestarts: Int
        /// Mic buffers since the previous tick.
        public var micBuffers: Int
        /// Loudest sample of those buffers, dBFS (−120 when none / all zero).
        public var micPeakDb: Float
        /// Loudest buffer RMS of those buffers, dBFS.
        public var micRmsDb: Float
        /// The recording has a system-audio track (and it is not muted by the user).
        public var systemLive: Bool
        /// The system track was audible at some point since the previous tick.
        public var systemAudible: Bool
        public init(t: Double, active: Bool, muted: Bool = false, micRestarts: Int = 0, micBuffers: Int,
                    micPeakDb: Float, micRmsDb: Float, systemLive: Bool = true, systemAudible: Bool) {
            self.t = t; self.active = active; self.muted = muted; self.micRestarts = micRestarts
            self.micBuffers = micBuffers; self.micPeakDb = micPeakDb; self.micRmsDb = micRmsDb
            self.systemLive = systemLive; self.systemAudible = systemAudible
        }
    }

    public enum Reason: String {
        case digitalSilence = "digital_silence"
        case silentWhileSystemAudible = "silent_while_system_audible"
    }

    public struct Detection: Equatable {
        public var reason: Reason
        /// How long the mic has been dead by that reason's measure, whole seconds.
        public var silentSeconds: Int
        /// Seconds of the last `quietSeconds` in which the system track was audible.
        public var systemAudibleSeconds: Int
        /// True for the follow-up after a re-detect: the mic is STILL dead.
        public var followUp: Bool
    }

    public let config: Config
    public init(config: Config = Config()) { self.config = config }

    private var eligibleSince: Double?
    private var lastRestarts = 0
    private var lastSignalAt = 0.0
    private var lastAudibleAt = 0.0
    private var lastLoudPeakAt = 0.0
    private var systemHistory: [(t: Double, audible: Bool)] = []
    private var lastFiredAt: Double?
    private var followUpDue: Double?
    private var holdUntilClear = false
    public private(set) var detections = 0
    /// What holds right now (nil = the mic is fine / not judged).
    public private(set) var condition: Detection?
    public private(set) var lastDetection: Detection?
    public private(set) var lastDetectedAt: Double?

    /// The controller re-detected the mic after a detection in automatic mode: check again
    /// `followUpSeconds` after `t`.
    public mutating func armFollowUp(at t: Double) { followUpDue = t + config.followUpSeconds }
    public var followUpPending: Bool { followUpDue != nil }

    private mutating func resetWindows(_ t: Double) {
        eligibleSince = t
        lastSignalAt = t; lastAudibleAt = t; lastLoudPeakAt = t
        systemHistory.removeAll()
    }

    public mutating func tick(_ k: Tick) -> Detection? {
        guard k.active, !k.muted else {
            // Off the hook: no judging, and nothing pending from before (a mute is an answer).
            eligibleSince = nil; condition = nil; followUpDue = nil; systemHistory.removeAll()
            return nil
        }
        if eligibleSince == nil || k.micRestarts != lastRestarts { resetWindows(k.t) }
        lastRestarts = k.micRestarts
        let since = eligibleSince ?? k.t
        let judgedFrom = since + config.graceSeconds
        // Inside the grace a fresh engine may hand out zeros while it warms up: nothing it
        // says counts, either way — the windows begin when the grace ends.
        if k.t < judgedFrom {
            lastSignalAt = judgedFrom; lastAudibleAt = judgedFrom; lastLoudPeakAt = judgedFrom
            condition = nil
            return nil
        }
        if k.micBuffers > 0 {
            if k.micPeakDb >= config.zeroFloorDb { lastSignalAt = k.t }
            if k.micRmsDb > config.audibleDb { lastAudibleAt = k.t }
            if k.micPeakDb >= config.quietMicPeakCeilingDb { lastLoudPeakAt = k.t }
        }
        systemHistory.append((k.t, k.systemLive && k.systemAudible))
        systemHistory.removeAll { k.t - $0.t >= config.quietSeconds }
        let systemAudibleS = systemHistory.filter { $0.audible }.count

        let zeroFor = k.t - lastSignalAt
        let quietFor = k.t - max(lastAudibleAt, lastLoudPeakAt)
        var now: Detection?
        if k.micBuffers > 0 && zeroFor >= config.zeroSeconds {
            now = Detection(reason: .digitalSilence, silentSeconds: Int(zeroFor), systemAudibleSeconds: systemAudibleS, followUp: false)
        } else if k.micBuffers > 0, k.systemLive, quietFor >= config.quietSeconds,
                  Double(systemAudibleS) >= config.quietSystemFraction * config.quietSeconds {
            now = Detection(reason: .silentWhileSystemAudible, silentSeconds: Int(quietFor), systemAudibleSeconds: systemAudibleS, followUp: false)
        }
        condition = now

        if let due = followUpDue {
            guard k.t >= due else { return nil }
            followUpDue = nil
            // Still dead after the re-detect? The quiet rule's minute cannot have refilled
            // yet, so the follow-up asks the smaller question over the time since the new
            // engine's grace: nothing from the mic while the call went on (system audible for
            // `quietSystemFraction` of it). A silent room with a silent call is not evidence.
            var still = now
            let sinceJudged = systemHistory.filter { $0.t >= judgedFrom }
            let systemSinceJudged = sinceJudged.filter { $0.audible }.count
            if still == nil, k.micBuffers > 0, k.systemLive, quietFor >= config.followUpQuietSeconds,
               Double(systemSinceJudged) >= config.quietSystemFraction * Double(sinceJudged.count) {
                still = Detection(reason: .silentWhileSystemAudible, silentSeconds: Int(quietFor), systemAudibleSeconds: systemAudibleS, followUp: false)
            }
            guard var d = still else { return nil }
            d.followUp = true
            fire(d, at: k.t)
            holdUntilClear = true
            return d
        }
        guard let d = now else { holdUntilClear = false; return nil }
        if let last = lastFiredAt {
            if k.t - last < config.cooldownSeconds { return nil }
            if holdUntilClear && k.t - last < config.backoffSeconds { return nil }
        }
        holdUntilClear = false
        fire(d, at: k.t)
        return d
    }

    private mutating func fire(_ d: Detection, at t: Double) {
        lastFiredAt = t
        lastDetection = d
        lastDetectedAt = t
        detections += 1
    }
}
