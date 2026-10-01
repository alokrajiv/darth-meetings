/// 0.3.20 — what the tray's diagnostics may collect, and how often the sampler runs.
///
/// Two levels. **full** (the default, and the policy on company Macs) collects everything;
/// **partial** (a person's own Mac, their choice) keeps only machine-level, content-blind
/// numbers: our own process's cost, system-wide CPU / GPU / memory pressure / swap / thermal /
/// battery / low-power, the hardware model and specs, the capture pipeline's counters and the
/// "This feels laggy" stamp with that same snapshot. Nothing that names or measures another app.
///
/// Every rich collector asks `TelemetryPolicy.allows` BEFORE it gathers anything — a partial
/// Mac never lists processes or reads another app's GPU time only to drop it afterwards.
public enum TelemetryLevel: String, CaseIterable {
    case full
    case partial

    public static let `default`: TelemetryLevel = .full

    /// What UserDefaults holds (`telemetryLevel`); nil or anything unknown is the default.
    public init(stored: String?) {
        self = stored.flatMap(TelemetryLevel.init(rawValue:)) ?? .default
    }
}

public enum TelemetryCollector: String, CaseIterable {
    /// Own process + system-wide CPU / GPU / memory / swap / thermal / battery / low power.
    case machineStats
    /// hw.model, chip, RAM, core counts, GPU cores.
    case hardwareIdentity
    /// Per-segment capture health (frames, drops, back-pressure, CoreAudio overloads).
    case captureCounters
    /// The "This feels laggy" stamp itself (with the machine snapshot).
    case lagReport
    /// Top processes by CPU (names other apps).
    case processList
    /// Per-process GPU time from the AGX user clients (measures other apps).
    case processGPU
    /// The tail of tray.log (window titles, app names).
    case logExcerpt
    /// `window_pick` with the CALL APP's own windows (meeting metadata the tray already ships)
    /// and `window_title_changed` for the recorded window.
    case callWindows
    /// `window_pick` with EVERY on-screen window (owner, title, bounds, z) — what beat what.
    case screenWindows
}

public enum TelemetryPolicy {
    /// May `collector` run at `level`?
    public static func allows(_ collector: TelemetryCollector, level: TelemetryLevel) -> Bool {
        switch collector {
        case .machineStats, .hardwareIdentity, .captureCounters, .lagReport, .callWindows:
            return true
        case .processList, .processGPU, .logExcerpt, .screenWindows:
            return level == .full
        }
    }
}

/// 0.3.20 — the resource sampler's pace. It always runs (the status payload carries the latest
/// sample), but it only LOGS while a recording runs or a call is live, so a laggy call that was
/// never recorded still leaves numbers behind.
public enum SamplerPacing {
    public static let recordingInterval: Double = 10
    /// Call live, not recording: half the volume of a recording.
    public static let callInterval: Double = 30
    public static let idleInterval: Double = 60
    /// The process list / per-process GPU sample, while a call or a recording is live.
    public static let processInterval: Double = 60

    public static func interval(recording: Bool, callLive: Bool) -> Double {
        recording ? recordingInterval : callLive ? callInterval : idleInterval
    }

    /// Is a sample worth a `resource_sample` event?
    public static func logs(recording: Bool, callLive: Bool) -> Bool { recording || callLive }

    /// Should the process sampler be running?
    public static func processSampling(recording: Bool, callLive: Bool, level: TelemetryLevel) -> Bool {
        (recording || callLive) && TelemetryPolicy.allows(.processList, level: level)
    }
}
